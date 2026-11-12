// AI 流式代理命令（独立模块：tauri::command 宏在子模块展开，避免与 lib 顶层命名空间冲突）
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use futures_util::StreamExt;
use tauri::Emitter;

/// AI 流式代理：转发 DeepSeek（OpenAI 兼容）SSE 流到前端。
/// 事件经 `ai://event` 推送给渲染层；重活下沉 Rust，UI 零阻塞。
pub const AI_EVENT_CHANNEL: &str = "ai://event";

/// 已请求中止的 ai_stream requestId 集合（前端超时后调用 ai_stream_abort 标记，
/// 流循环每个分片检查一次并提前退出，避免僵尸流继续消耗网络与产生迟到事件）。
fn aborts() -> &'static Mutex<HashSet<String>> {
    static ABORTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ABORTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_aborted(request_id: &str) -> bool {
    aborts().lock().map(|set| set.contains(request_id)).unwrap_or(false)
}

/// 离开作用域时自动从 abort 集合移除本请求（所有 return 路径都清理，防集合泄漏）。
struct AbortGuard(String);
impl Drop for AbortGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = aborts().lock() {
            set.remove(&self.0);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamRequest {
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub messages: Vec<AiChatMessage>,
    /// OpenAI 工具定义（透传）
    #[serde(default)]
    pub tools: Vec<serde_json::Value>,
    /// 是否已禁用工具调用（写文件审批等待时由前端置 true，避免工具循环）
    #[serde(default)]
    pub no_tools: bool,
    /// 请求标识：回显到每个事件，前端据此过滤旧流迟到的事件（超时后僵尸流不再串扰新请求）
    #[serde(default)]
    pub request_id: String,
    /// 每次流式事件的字符串增量上限（SSE 行过长时截断防前端卡顿）
    #[serde(default = "default_delta_limit")]
    pub delta_limit: usize,
}

fn default_delta_limit() -> usize {
    64 * 1024
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiStreamEvent {
    Start,
    Delta { text: String },
    /// 完整响应（含工具调用块，JSON 数组字符串）
    Done { full_text: String, tool_calls: Option<String> },
    Error { message: String },
}

#[derive(Clone, Serialize)]
pub struct TaggedAiStreamEvent {
    pub request_id: String,
    #[serde(flatten)]
    pub event: AiStreamEvent,
}

#[tauri::command]
pub async fn ai_stream(
    app: tauri::AppHandle,
    request: AiStreamRequest,
) -> Result<(), String> {
    let request_id = request.request_id;
    let _guard = AbortGuard(request_id.clone());
    if is_aborted(&request_id) {
        return Err("AI 请求已中止".into());
    }
    let emit_request_id = request_id.clone();
    let emit = move |ev: &AiStreamEvent| {
        let _ = app.emit(
            AI_EVENT_CHANNEL,
            TaggedAiStreamEvent { request_id: emit_request_id.clone(), event: ev.clone() },
        );
    };
    emit(&AiStreamEvent::Start);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

    // 消息体：系统提示词 + 历史（json! 宏不支持迭代器展开，手动构建数组）
    let mut messages: Vec<serde_json::Value> = vec![serde_json::json!({
        "role": "system",
        "content": request.system_prompt
    })];
    for m in &request.messages {
        messages.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }
    let mut payload = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": false }
    });
    if !request.no_tools && !request.tools.is_empty() {
        payload["tools"] = serde_json::Value::Array(request.tools);
        payload["tool_choice"] = serde_json::json!("auto");
    }

    let resp = client
        .post("https://api.deepseek.com/chat/completions")
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}（请检查网络与 API Key）"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误 {status}：{}", truncate(&body, 500)));
    }

    // SSE 解析：逐行读 data: 块，拼装 delta 文本与 tool_calls 增量
    let mut full_text = String::new();
    // OpenAI 流式 tool_calls 是分块增量：index → (id, name, arguments)
    let mut tool_acc: std::collections::BTreeMap<u64, serde_json::Value> = Default::default();
    let mut tool_ids: std::collections::BTreeMap<u64, String> = Default::default();
    let mut tool_names: std::collections::BTreeMap<u64, String> = Default::default();

    let mut stream = resp.bytes_stream();
    // 按字节累积而不是按字符串：网络分片可能落在多字节 UTF-8 字符中间，
    // 逐片 from_utf8_lossy 会把被切开的中文替换成 �（流式中文乱码、且无法还原）。
    // 行尾的 \n 是 ASCII，因此能切出换行时，该行之前的多字节字符一定完整。
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        // 前端超时/停止后标记中止：尽早退出，不再产生迟到事件
        if is_aborted(&request_id) {
            return Err("AI 请求已中止".into());
        }
        let chunk = chunk.map_err(|e| format!("流式读取失败：{e}"))?;
        buf.extend_from_slice(&chunk);
        // 按行处理（SSE 事件以 \n 分隔；兼容 \r\n）
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..pos]).to_string();
            let line = line.trim_end_matches('\r');
            buf.drain(..pos + 1);
            if !line.starts_with("data:") {
                continue;
            }
            let data = line[5..].trim().to_string();
            if data == "[DONE]" {
                break;
            }
            let parsed: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue, // 心跳/keep-alive 等非 JSON 行
            };
            if let Some(choices) = parsed["choices"].as_array() {
                for choice in choices {
                    let delta = &choice["delta"];
                    if let Some(text) = delta["content"].as_str() {
                        if !text.is_empty() {
                            full_text.push_str(text);
                            // 增量事件限长（防超长行卡渲染）
                            // 切分点必须在 UTF-8 字符边界：中文 delta 直接按字节 split_at 会 panic
                            let limit = request.delta_limit.max(1);
                            let mut pending = text.to_string();
                            while pending.len() > limit {
                                let at = delta_split_index(&pending, limit);
                                let (head, rest) = pending.split_at(at);
                                emit(&AiStreamEvent::Delta { text: head.to_string() });
                                pending = rest.to_string();
                            }
                            emit(&AiStreamEvent::Delta { text: pending });
                        }
                    }
                    // 工具调用增量：{index, id?, type, function:{name?, arguments?}}
                    if let Some(tcs) = delta["tool_calls"].as_array() {
                        for tc in tcs {
                            let idx = tc["index"].as_u64().unwrap_or(0);
                            if let Some(id) = tc["id"].as_str() {
                                tool_ids.insert(idx, id.to_string());
                            }
                            if let Some(name) = tc["function"]["name"].as_str() {
                                tool_names.insert(idx, name.to_string());
                            }
                            if let Some(args) = tc["function"]["arguments"].as_str() {
                                let entry = tool_acc
                                    .entry(idx)
                                    .or_insert_with(|| serde_json::json!({ "arguments": "" }));
                                entry["arguments"] = serde_json::Value::String(
                                    entry["arguments"].as_str().unwrap_or("").to_string() + args,
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // 组装 tool_calls（若有）
    let tool_calls = if tool_acc.is_empty() {
        None
    } else {
        let arr: Vec<serde_json::Value> = tool_acc
            .iter()
            .map(|(idx, v)| {
                serde_json::json!({
                    "id": tool_ids.get(idx).cloned().unwrap_or_default(),
                    "type": "function",
                    "function": {
                        "name": tool_names.get(idx).cloned().unwrap_or_default(),
                        "arguments": v["arguments"].as_str().unwrap_or("{}")
                    }
                })
            })
            .collect();
        Some(serde_json::to_string(&arr).unwrap_or_default())
    };

    emit(&AiStreamEvent::Done {
        full_text,
        tool_calls,
    });
    Ok(())
}

/// 中止指定流（前端看门狗超时用）：标记 requestId，流循环检测后退出并清理。
#[tauri::command]
pub fn ai_stream_abort(request_id: String) -> Result<(), String> {
    if let Ok(mut set) = aborts().lock() {
        set.insert(request_id);
    }
    Ok(())
}

/// 返回 ≤ index 的最近 UTF-8 字符边界（index 超出长度时返回长度）。
fn char_boundary_floor(s: &str, index: usize) -> usize {
    let mut end = index.min(s.len());
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// 流式增量的切分位置：在 limit 处向前找字符边界；若 limit 落在首个多字节字符内部，
/// 至少取完该字符，保证循环一定前进（否则 limit < 字符宽度时会死循环）。
fn delta_split_index(s: &str, limit: usize) -> usize {
    let floor = char_boundary_floor(s, limit);
    if floor > 0 {
        floor
    } else {
        s.chars().next().map(|c| c.len_utf8()).unwrap_or(0)
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // 按字符边界截断：错误体常含中文，直接按字节切片会 panic（byte index not a char boundary）
        let end = char_boundary_floor(s, max);
        format!("{}…", &s[..end])
    }
}
