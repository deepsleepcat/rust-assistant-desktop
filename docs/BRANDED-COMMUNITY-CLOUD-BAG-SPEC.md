# 铁锈工坊品牌社区 + 云书包 —— 桌面端实现契约

- 仓库：`W:/mao/tx/ohmytx`（分支 `feat/branded-community-cloud-bag` @ 13d642e）
- 配对后端契约：`ohmytxhouduan/docs/CLOUD-BAG-API-DATA-CONTRACT.md`（同分支，两侧字段逐字一致，改一侧必须同 PR 记录改另一侧）
- 本文档是**设计契约**：定义本轮「真实实现」与「后续能力」的硬边界。禁止假按钮、禁止静态占位数据、禁止指向不存在路由的链接。
- 证据锚点均为本会话实际读取核实过的代码行。

---

## 0. 六方研究冲突裁决（桌面侧相关）

| # | 冲突 | 裁决 | 依据 |
|---|------|------|------|
| J1 | 云书包 API 前缀：`/api/mods/*` vs `/api/community/cloudbag/**` | **取 `/api/community/cloudbag/**`** | Caddy 匹配器已放行 `/api/community/*`（Caddyfile:17），桌面 IPC 前缀族已放行 `/^\/api\/community\//`（communityIpc.ts:58）——JSON 端点两端零发版 |
| J2 | 表前缀 `mod_repos` vs `cloudbag_*` | **取 `cloudbag_*`** | 后端 docs/DATA-MODEL.md:18、56 已预留该前缀约定 |
| J3 | 冲突信号：产品侧写「服务端 409」 vs 后端「HTTP 200 + success:false + code」 | **取后者**：HTTP 恒 200 信封，`code=version_conflict` | 现有业务错误契约就是 200 + success:false（communityApi.ts:18-22 信封；community_resource.go:98 先例）；桌面**不得**按 HTTP 状态码分支，只按 `code` 分支 |
| J4 | 角色三档命名：collaborator vs editor | **owner / editor / viewer** | 与后端契约一致，`collaborator` 一词废弃 |
| J5 | 大文件上传两阶段（init/PUT/commit） | **V1 不做**；单文件 blob ≤50MiB multipart | 桌面 IPC 上传上限就是 50MiB（communityIpc.ts:65,101），两阶段会迫使新增白名单路径 + 方法语义，推到 V2 |
| J6 | 服务端是否解包客户端 zip | **V1 服务端不解包任何客户端 zip**：导入 = 桌面 `importModBuffer` 本地解包后逐文件传 blob；导出 = 服务端按版本树**打包** .rwmod | 消除服务端 zip-bomb 攻击面；安全审查的 zip 用例只落在客户端导入与（服务端）导出打包 |
| J7 | 配额语义 | 云书包**独立**建 `cloudbag_quota_accounts/ledger`，与社区资源 500MB 用户配额（community_base.go:36）互不读写 | 避免 domain 侧指出的双轨计费 |
| J8 | 截图菜单与外部聊天导航 | 截图菜单的具体来源尚未由真实加载页面确认；源码未找到对应来源不能推断为操作系统任务栏。自有 `new-api/web` 移除 Token 外部聊天深链、App `/console/chat` 与 `/chat2link` 路由及聊天设置入口，status 不再保存外部 chats 并清除旧缓存；恢复 Playground 实际侧栏菜单 | 保留网关 Playground、Token 管理与许可归属；修改只在自有前端，部署必须托管其真实构建静态产物，不能把上游镜像源码修改称为已生效 |

---

## 1. 范围硬边界：本轮真实实现 vs 后续能力

### 1.1 本轮必须真实可用（逐条接真实 API，全链路无死按钮）

1. 社区四页签（推荐/关注/排行/我的）保持现状在线能力。
2. 社区面板新增第 5 页签「云书包」（`communityData.ts` TAB_LABELS 增 `cloudBag` 项；SurfaceNav **不**新增第四个顶级入口，见 §4）。
3. 云书包 V1 能力（对应后端契约 §3 的端点）：
   - 仓库列表 / 搜索 / 详情（含版本列表）
   - 创建仓库（名称/简介/标签/可见性）
   - 从当前项目导入：本地项目（工作台当前打开的已登记项目根）→ 逐文件 blob 上传 → 建首个版本
   - 导入 .rwmod 文件：`bridge.mod.import('archive')`（`electron/modPack.ts` `importModBuffer`
     的 zip-slip/条目数/单文件与总量/设备名/失败回滚全量防护）解包到用户选择的目录后同上
     （实测路径见 §6.1：复用同一推送链路 `pushLocalTree`，不新增第二条上传通道）
   - 文件树浏览（树内单文件读取走 `GET .../versions/:no/file?path=`）
   - 提交（写中文说明 + base_version_no 乐观锁推版本）
   - 差异（服务端文件级 sha diff：新增/删除/修改三态列表；文本级 diff 仅对本地工作树走既有 `gitTools.diffBetween`）
   - 发布（tag + 服务端打包 .rwmod 下载）——**桌面 V1 降级**：releases 页签未实现，
     版本页消费 `releases/shares` 列表展示持久记录；创建/撤回发布请走社区网页端
     （网页端从服务端重新读取历史，刷新后仍可展示和撤回）。
   - 下载 / 导出 .rwmod（保存到本地，可再经 `importModBuffer` 入库）
   - 回滚（= 以旧版本树新建版本，`revert` 语义，绝不改写历史）
   - 分享链接（`link` 可见性 token）——**桌面 V1 降级**：`createShare/revokeShare` 方法已就绪但
     无调用点；link 可见性仓库的「复制链接」在桌面为 disabled + title「未支持：
     一次性分享 token（请在社区网页创建分享）」，不再复制对接收者无效的无 token 深链。
   - 成员管理（owner 邀请站内已验证用户为 editor/viewer，可移除）
   - 同步冲突解决（`code=version_conflict` → A/B 选择界面，见 §6.7）
4. 未支持项显式降级（disabled 按钮 + title「未支持」，参照 CommunityPanel.tsx:443 disabled-row + local-note 模式）：Issue/PR 评审、Star/Fork 社交图谱、Wiki、CI 构建、实时多人协同编辑、**网页端在线编辑仓库文件**、移动端、两阶段大文件上传（>50MiB 单文件）。

### 1.2 后续能力（本轮 UI 不得出现对应入口，文档可提及）

自动同步/文件监听；服务端文本 diff/三方合并/分支；依赖自动解析安装；设置与对话历史云同步；服务端加密（三期「加密三档全服务器」，V1 云上明文，UI 需在仓库创建页明示提示文案）；>50MiB 两阶段上传。

### 1.3 禁止事项（审查即拒）

- 渲染静态假数据（离线示例数据仅限既有社区页签的 `localCommunityDataSource`，云书包页签**不提供**离线示例）。
- 任何 disabled 按钮可被键盘/点击触发到不存在路由。
- 云书包写操作绕过登录/邮箱验证拦截。

---

## 2. 品牌资源边界（来自品牌设计师 Brief，经裁决采纳）

### 2.1 保留的黑白/高对比/紧凑语言（回归红线）

- 单色图标染色管线：`src/styles/tokens.css:73`（浅 `--icon-filter: brightness(0)`）、`:128`（深 `brightness(0) invert(1)`）；新图标一律走 AppIcon 语义名入口，禁止彩色功能图标。
- 令牌词汇表：surface-0/1/2、text-primary/secondary/muted、accent（#111 浅 / #8ab4f8 深）。新增样式只允许消费令牌，禁止硬编码色值。
- 紧凑刻度 `--ctrl-h 32/26`、radius 4/6/8/10/12（tokens.css:17-25）、36px 页签条与 1px 边框卡片（community.css:17-23/92-101）；阴影只用于浮层。`body.ra-compact` 窄屏规则与 color-mix 混合模式（community.css:259-272）保留。
- LogoR 保持内联 SVG + currentColor（`src/components/LogoR.tsx`），深浅色自适应；云书包不引入第二套视觉体系。

### 2.2 本轮必须完成的品牌收编（桌面仓侧无改动，仅契约记录 + 门禁）

桌面仓品牌资产已自有（build/icon-256.png/icon-1024.png/icon.ico、build/icon.html、public/favicon.svg、public/icons/ + ICON-LICENSE.txt）。本轮桌面仓**无需**新增 brand/ 目录（那是后端 web 侧的收编方案，见后端契约）。桌面侧只需遵守两条：

1. 65 枚图标集单一真身定在 `ohmytx/public/icons/`；后端 `new-api/web/public/icons/` 是脚本分发的副本。**任一端加图标必须跑同步脚本**（对账逐文件 sha256 + AppIcon 语义名清单 diff 为空），禁止跨仓静态 import。
2. 许可红线：570+Icons-CN-v1.0.3 禁止转售图标包——65 枚集**不得**发布为 npm 包或素材包（public/icons/ICON-LICENSE.txt）。

### 2.3 品牌门禁四项（纳入常规回归，两仓同跑）

① `src` 内无外部图片 URL（`lf3-static.bytednsdoc.com` 等 http(s) 图片引用）；② index.html/HeaderBar/Footer/LoginForm 只引用 `/brand/` 或 `icons/` 路径；③ 两仓 AppIcon 语义名清单 diff 为空；④ brand/ 清单校验和匹配。桌面侧 grep 需排除 node_modules/dist/dist-electron/.zcode/.mimosa。

---

## 3. 截图入口清理清单

**裁决：删除清单为空。** 本会话复核（六方 + 本契约）：`grep -rniE "cherry|aionui|cc.?switch|deepchat|aqbot|lobe|问天|opencat|截图|screenshot|html2canvas"` 在三个前端源码、构建产物与 `git log --all -S"截图" -- src electron` 均无产品代码命中（唯一相关提交 a38eb49 仅改 .gitignore）。因此：

- 本轮**没有任何「截图入口」可删**——只能证明当前不存在，不能证明存在过「移除」动作；验收为**负面断言**：黑盒阶段断言每个页面 DOM 无文本为「截图/生成截图/保存截图」或 capture/poster 语义的控件，并记录该事实。
- 后续不得新增任何截图入口，除非先修订本节契约。

---

## 4. 三端导航与入口（「一个身份、三个门」）

| 端 | 入口 | 云书包落点 | 边界 |
|----|------|-----------|------|
| 桌面 | SurfaceNav「社区」项（src/features/workspace/SurfaceNav.tsx:16-19） | CommunityPanel 内新增第 5 页签「云书包」（communityData.ts TAB_LABELS） | 不新增 SurfaceNav 顶级项；窄窗抽屉模式点击切换即收（SurfaceNav.tsx:26-30） |
| 独立社区站 | `/community/*`（ohmytxhouduan/community/web） | 本轮**只读**：仓库页 `/community/repos/:slug` 深链展示元数据/版本列表/下载 | 不承载在线编辑（未支持） |
| 网关前端 | `/community` 页 + 侧栏社区组（App.js:267、SiderBar.js:268-275） | 保持只读引流 | 不承载云书包完整 UI；禁止凭截图相似度删网关导航 |

canonical 品牌名统一为「铁锈工坊社区」。`/device/approve` 为唯一设备审批页（electron/communityAuth.ts:13）。

---

## 5. 认证、状态机与离线行为

- 社区状态机沿用现状：`checking/loading/signed_in/signed_out/error/offline`（src/stores/workspace.ts:178-303）；云书包页签消费同一状态，不建第二状态机。
- 云书包所有写操作复用 `requireInteraction` 拦截（CommunityPanel.tsx:150-161）：未登录 → 引导登录（设备配对，LoginScreen.tsx:27-33），未邮箱验证 → 跳设置认证。
- **离线（`offline`）时云书包页签**：页签可切换，内容区显示真实状态说明 +「重试」按钮（重试真实请求），**不渲染任何本地示例仓库**。所有写按钮 disabled + title「离线中，连接社区后可用」。
- 状态徽标三态（在线 success / 本地示例·仅桌面回退 info / 离线 badge，CommunityPanel.tsx:334-356）对云书包页签同款展示；徽标取自 communityAuth 真实状态。
- sk- 令牌语义钉死：`sk-[A-Za-z0-9]{48}`（communityAuth.ts:213-215）是社区配对身份；网关 sk- 令牌是 AI relay 凭据。云书包请求走 `/api/community/cloudbag/**`（社区中间件链），**绝不**出现在网关 relay 鉴权路径。

---

## 6. 云书包用户流（每步对应真实端点）

端点全表见后端契约 §3；此处只定桌面侧行为与流转。所有请求经既有 `community:request` IPC 代理（communityIpc.ts 前缀族），渲染层无 token（communityApi.ts:264-269 模式）。

### 6.1 空态 → 创建/导入
- 空态两个主按钮（`CloudBagPanel.tsx` 空态 action）：**「创建模组仓库」**（`POST /cloudbag/repos`，表单：title/slug 建议/description/visibility/标签 ≤8 个 ≤32 rune）与**「从当前项目导入」**（打开 `ImportToCloudModal`：同一表单 + 源目录选择 + 版本说明）。
- 导入两条路（`ImportToCloudModal`，编排在 `cloudBagSync.importTreeToNewRepo`）：a) 当前项目目录直接作为初始文件树（需工作台已打开项目）；b) 选择 .rwmod/.zip → 主进程 `mod:import`（`importModBuffer` 全量防护：zip-slip/20000 条目/128MB 单文件/512MB 总量/设备名/失败回滚）解包到**用户选择的目录**（V1 复用既有导入对话框，不做隐式临时目录）后作为文件树。两条路都是「`POST /cloudbag/repos` 建仓 → `pushLocalTree`（`base_version_no=0`）提交首版本」。
- 导入进度按文件粒度展示；被跳过/超限/类型不支持的文件与原因为何都必须在弹窗内列出（不静默丢弃）。
- 任一文件超 50MiB → 该文件计入「超过 50 MiB」清单并跳过（V1 无两阶段，见 J5）；非 UTF-8（GBK/ANSI）文本同样跳过并报告，绝不做有损改写上传。

### 6.2 仓库页信息架构（GitHub 风格映射）
- 头部：title / slug 深链 / description / 标签 / visibility 徽标 / 成员数 / 配额占用（repo scope used/limit，来自 `GET /repos/:slug`）。
- 页签：文件树（当前 head 版本）/ 版本列表（游标分页）/ 成员 / 设置（owner only）。
  「发布（releases）」子页签为 **V1 未支持**（见 §1.1 降级说明），发布与分享请在社区网页端操作。
- 关联社区帖（可选，owner 设置）：repo → post 单向弱关联，`PUT /repos/:slug` 带 `post_id`；帖子详情侧展示仓库卡片。

### 6.3 文件树
- 数据 = `GET /repos/:slug/versions/:no/tree`（后端由 cloudbag_version_files 展开成树）；纯键盘可导航（沿用现有树控件约定）。
- **游标分页必须串起来**：后端默认 limit=200、上限 500，`nextCursor` 非空即还有后续页。桌面按 `limit=500` 请求并在 `nextCursor` 非空时渲染「加载更多文件（已 N / M）」与截断提示——禁止只取首页且丢弃 nextCursor（>200 文件的仓库会静默只显示一部分）。
- 单文件预览：`GET .../versions/:no/file?path=`（≤2MB、白名单扩展）；cover 图走同端点。
- V1 文件树**只读**（网页在线编辑属未支持清单）。桌面编辑发生在本地项目，见 6.4。

### 6.4 提交（手动同步，仅两个动作按钮）
- 本地锚点 `.ohmytx/cloud.json`：`{repoSlug, baselineSeq, baselineTreeDigest, lastSyncedAt}`，由主进程同步流程写入；**必须**同时加入 `electron/modScan.ts` PACK_EXCLUDE_PATTERNS（modScan.ts:13-27）防止锚点被打进 .rwmod——此条需单测钉死。
- 锚点与打包排除判定**大小写不敏感**：目标平台 NTFS 不区分大小写，`.OHMYTX/cloud.json`、`.GIT/hooks/pre-commit` 一类变体会写到同一位置；恢复（`cloudbagRestore.validateZipEntries`）与打包/扫描（`modScan.isExcluded`）必须 `toLowerCase()` 后比较，排除判断对**完整相对路径**（任意深度命中即拒，不是只看首段）。恢复写盘前另做 realpath 锚点守卫：项目内链接/junction 落进 `.ohmytx` 时中止。
- 「发布新版本」流程：`gitTools.status`（src/types/bridge.ts:268-269 桥）列变更 → 对照白名单扩展过滤 → 逐文件 `POST /cloudbag/repos/:slug/blobs`（sha256 + session_id；同仓库同 sha 去重不占配额）→ `POST .../versions`（base_version_no、message 必填 ≤600 rune、client_op_id 幂等）。
- 「拉取版本」流程：四分态判定（本地变更 vs 远端 head）：clean 无动作 / 仅本地变 → 引导走发布 / 仅远端新 → 拉取覆盖前**强制本地备份**（复用 importModBuffer 两段式：全量校验后再写盘 + 失败回滚）/ 双向变 → 冲突界面（6.7），**V1 无合并**，UI 强制二选一并明示差异清单。
  - **V1 降级登记（本轮起明确）**：本地一侧用 `gitTools.status` 是否非空判定（`.ohmytx/**` 自身产物过滤掉），远端一侧比较 `remoteHeadVersionNo` 与锚点 `baselineSeq`；`baselineTreeDigest` 在 V1 **只保留字段、写空串、不参与判定**（树摘要计算未实现）。后果：非 git 项目恒落入 `local-ahead`/`conflict` 分支——不会误丢数据（服务端乐观锁仍在），但状态展示比「本地树哈希」方案保守。实现树摘要后需同步修订本行。
- 备份目录不可覆盖：`backup/<versionNo>/` 已存在（同一版本重复拉取）时改用 `backup/<versionNo>-<时间戳>[-n]/`，返回值 `backupDir` 回显真实落地位置；拉取前先对 `backupRoot` 做链接逃逸校验。空 zip（无文件条目）直接拒绝，绝不清空工作树。
- **覆盖语义的边界（第 4 轮修正）**：拉取只会移走**云书包可表示**的本地多余文件（白名单扩展名 + 路径合法 + ≤50MiB + 文本为合法 UTF-8；与上传侧 `buildLocalFilePlan`/`readLocalFileBytes` 同口径，主进程副本见 `electron/cloudbagTree.ts`，两侧一致性由测试锁定）。云书包根本无法表示的本地文件（`.gitignore`/`README.md`/`*.json`/`*.zip`/`*.rwmod` 产物/超限素材/GBK 文本）**留在本地不动**——上传侧对它们的处置是「留在本地并如实上报」，拉取侧必须同口径，否则用户会看到项目文件凭空消失。被移走的路径逐条经 `RestoreResult.movedList` 回传，UI 必须列清单而不只给数字；`remote-ahead`/`unbound` 态下也保留 `window.confirm` 说明「哪些文件会被移入备份」。
- **锚点的仓库维度（第 4 轮修正）**：四分态判定必须带 `repoSlug`——锚点存在但 `anchor.repoSlug !== 当前 repo.slug` 时一律返回 `unbound`。旧实现只比版本号：项目绑定仓库 A 后打开仓库 B，B 的 head 小会被误判 `clean`（两个动作按钮都被隐藏），head 大被判 `remote-ahead` 且无确认即可拉取，把 B 的树覆盖进绑定 A 的项目、随后锚点又被无条件改写＝静默改绑。UI 在该状态下必须显式提示「本项目已绑定仓库 X，继续会重设绑定与基线」，并在发布/拉取前二次确认。
- **路径段级非法字符（第 4 轮修正）**：`validateZipEntries` 除设备名/`..`/盘符外，还必须拒绝任一路径段含 `< > : " | ? *` 或以点/空格结尾（口径同 `fsIpc.assertValidName`，服务端 `validateCloudBagPath` 与网页 `cloudBagUtils.validateUploadPath` 同步收紧）。`units/tank.ini:evil` 词法上全在根内，但在 NTFS 上写的是 `tank.ini` 的备用数据流（ADS）：内容不可见、`readdir` 枚举不到，直接击穿「本地树等价远端树」的判定与备份计数。
- **上传时限（第 4 轮修正）**：blob 上传不得沿用 15s 的 JSON 超时（50MiB 需 ≥3.34MiB/s 持续上行，慢链路必然失败，且重试会把整包重发，白耗带宽）。渲染层与主进程用同一公式 `max(60s, bytes / 256KiB/s)`（`cloudBagApi.cloudBagUploadTimeoutMs` / `electron/cloudbagTree.ts`，一致性由测试锁定）；超时单列 `kind:'timeout'`（不按 `network` 重试，文案指向「上传超时/网页端上传」而非服务端故障）。
- **恢复的排除条目分两档（不做无解死路）**：确定性危险目录（`.git/.svn/.hg/node_modules`，任意深度、大小写不敏感）→ 中止整次恢复；其余噪声条目（`dist/out/dist-electron/.vite/*.tmp/Thumbs.db/desktop.ini/.DS_Store`）→ **跳过该条目并在 `skipped` 里回报**（服务端只跳过 `.ohmytx`，其他客户端完全可能合法提交含这些段的版本；整次中止会让这类版本在桌面端永久无法拉取）。`.ohmytx` 锚点条目始终跳过。被跳过的条目同时不参与 `listLocalFiles` 的「多余文件」判定，本地同名文件不会被移走。
- **桌面本地上限**：单文件 blob、单次导出/拉取均为 50MiB（`cloudBagApi.MAX_BLOB_BYTES/MAX_EXPORT_BYTES`、`communityIpc` 表驱动、`cloudbagRestore.MAX_RWMOD_BYTES`），服务端导出默认上限为 512MiB。超限是**本地限制**，错误文案必须区分（不得说成「服务端响应过大」），并提示更大仓库走社区网页端。
- 同步仅手动触发；不做文件监听/自动上传/轮询。
- 幂等键：同一次逻辑推送的 `client_op_id` 在失败重试间**复用**（`pushLocalTree` 对 `pushVersion` 的网络类失败重试并沿用同一 id，`CloudBagSyncModal` 对同一 base 的手动重试也复用），服务端 `uniqueIndex(repo_id,user_id,client_op_id)` 的幂等重放才真正生效；业务错误（version_conflict 等）不重试。

### 6.5 差异
- 服务端文件级 diff：`GET /repos/:slug/versions/:no/diff?against=<no>` → `[{path, change: added|removed|modified}]`。文本级 diff 仅对**本地** git 历史（GitInfoModal.tsx:41-59 选两版对比模式），不在云端做。

### 6.6 发布 / 下载 / 回滚 / 分享
- 发布：`POST /repos/:slug/releases`（version_no + notes）→ 状态 draft→published；下载 `GET /repos/:slug/versions/:no/export.rwmod`（服务端打包，走既有 download 响应纪律 nosniff/no-store/filename*）。桌面保存对话框后落盘，可提示「是否导入为本地项目」。
- 回滚：`POST /repos/:slug/versions` 带 `restore_from`（旧 seq），服务端复制旧树为新版本、message 记 `revert of #seq`；桌面 UI 文案必须写「回滚会创建一个新版本，历史不会被改写」。
- 分享：`POST /repos/:slug/shares` → 返回**一次性明文 token**（服务端只存 hash）；桌面复制 `https://<站>/community/repos/:slug?share=<token>`；撤销 `DELETE /shares/:id` 后旧链接 404。
  （端点契约在服务端与社区网页端已实现；桌面端 V1 未实现发布/分享 UI，见 §1.1 降级说明。）

### 6.7 冲突解决界面（数据源抽象）
- 触发：推送返回 `success:false + code=version_conflict`，data 内含服务端 head 清单摘要（J3：不看 HTTP 状态码）。
- UI：A（本地变更）/ B（远端 head）双栏文件级差异清单 + 差异文件数摘要；交互复用 GitInfoModal 冲突块的选择模式，但数据对象是**服务端版本**而非 `<<<<<<<` 标记——需把 GitInfoModal 的冲突交互抽出为数据源无关组件（这是 domain 侧警告的低估点，排期按独立组件对待）。
- 两个出口：「以本地发布新版本」（走 6.4 推送流，base_version_no=远端 head，用户先核对差异）或「放弃本地改动拉取」（强制先本地备份）。

---

## 7. 桌面 bridge / API 类型契约

### 7.1 新文件与扩展点（本轮真实实现）

- `src/services/cloudBagApi.ts`（新）：类型 + fetch 客户端，注入模式与 `communityApi.ts:5-7` 相同（可注入假 fetch）；信封沿用 `CommunityResponse`（`{success, message, data, code?}`），`code` 为本契约新增的机器可读字段。
- `src/features/community/communityData.ts`：TAB_LABELS 增 `cloudBag: '云书包'`；roving tabindex 复用 CommunityPanel.tsx:361-374 的 ←/→ 模式。
- `src/types/` 新增类型（渲染层与服务端逐字一致）：

```ts
type CloudBagVisibility = 'private' | 'public' | 'link'
interface CloudBagRepo {
  id: number; slug: string; title: string; description: string
  visibility: CloudBagVisibility
  tags: string[]
  headVersionNo: number; fileCount: number; versionCount: number
  totalSize: number; postId: number | null
  quota: { usedBytes: number; limitBytes: number }
  myRole: 'owner' | 'editor' | 'viewer' | null
  updatedAt: number  // unix 秒
}
interface CloudBagTreeEntry { path: string; size: number; sha256: string }
interface CloudBagManifest {            // 服务端从 mod-info.txt [mod] 节解析生成
  title: string; description: string; thumbnail: string
  version: string; author: string; update: string; minVersion: string
  brokenRefs: string[]                  // 警告性：树内引用缺失列表
}
interface CloudBagVersion {
  id: number; versionNo: number; parentVersionNo: number | null
  message: string; manifest: CloudBagManifest
  fileCount: number; totalSize: number
  createdByUserId: number; createdAt: number
}
interface CloudBagDiffEntry { path: string; change: 'added' | 'removed' | 'modified' }
interface CloudBagSyncSession { id: string; status: 'open' | 'committed' | 'aborted'
  files: Array<{ path: string; sha256: string; state: 'pending' | 'done' | 'failed' }> }
type CloudBagErrorCode =
  | 'version_conflict' | 'quota_exceeded' | 'file_too_large' | 'unsupported_extension'
  | 'invalid_path' | 'manifest_parse_failed' | 'object_hash_mismatch'
  | 'not_found' | 'forbidden'
```

信封按端点键展开（与 web 端 cloudBagApi.js 同一实现）：`GET /repos/:slug` → `data.repo`、
`GET /repos/:slug/versions/:no` → `data.version`、`diff` → `data.items`、
`POST /repos/:slug/versions` → `data.sync.resultVersionNo`（`data.sync.replay=true` 表示幂等重放，
**不是**错误码——后端契约 §3.3 明确不存在 `idempotent_replay` 错误分支，故本码已从类型中删除）。
`POST /repos/:slug/sessions` 的字段名为 `sessionId`（桌面内部展开为 `CloudBagSyncSession.id`）。

### 7.2 桌面 IPC 一次性通用化（云书包联调**前置项**）

`electron/communityIpc.ts` 需一次发版（本轮真实实现）：
1. 上传精确路径 `/^\/api\/community\/posts\/\d+\/resources$/`（:95）扩为表驱动 `{pattern, methods, maxBytes}`，纳入 `/^\/api\/community\/cloudbag\/repos\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/blobs$/`（POST，50MiB）。slug 形态与后端建仓规则一致（`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，契约 §3.2），不是纯数字 id。
2. 下载判定 `url.pathname.endsWith('/download')`（:141）改为显式家族正则（`/export\.rwmod$/`、`/shares\/[A-Za-z0-9]+\/download$/`、`/^\/api\/community\/resources\/\d+\/download$/` 三者 50MiB；`/file$` ≤2MiB），上限同样表驱动。家族外的 `/download` 结尾路径退回 JSON 2MiB 上限（收紧，不再放行 50MiB）。
   **帖子附件必须在家族内**：`/api/community/resources/<id>/download` 是 `communityApi.download()` 实际打的路径（client 侧 50MiB 上限、上传侧同为 50MiB），漏列会让 2~50MiB 的既有附件在桌面端被误判为「响应过大」。
3. 其余 JSON 端点零改动——`/^\/api\/community\//` 前缀族已覆盖（:58）。origin/hostname 双校验、redirect:'error'、头剥离、凭据注入边界**逐字不变**（ipc.test.ts 全部用例必须保持绿）。

在 7.2 发版落地前，云书包上传/下载按钮 disabled + title「需要更新桌面版」——不允许以任何方式绕过 IPC 白名单。

---

## 8. 错误与文案映射（code → 用户文案）

| code | 文案 |
|------|------|
| version_conflict | 远端已有新版本，请先查看差异再选择合并方式 |
| quota_exceeded | 云书包空间不足（显示 scope 与 used/limit） |
| file_too_large | 单文件超过 50 MiB，本轮不支持更大文件 |
| unsupported_extension | 该文件类型不在模组资产白名单内 |
| invalid_path | 文件路径不合法 |
| manifest_parse_failed | mod-info.txt 解析失败，无法识别模组信息 |
| object_hash_mismatch | 文件校验不一致，请重试上传 |
| forbidden | 你在该仓库没有执行此操作的权限 |
| not_found | 仓库或版本不存在（分享链接失效同此文案，不区分原因） |

网络层错误（fetch 抛错/超时）→ 「连接社区服务器失败」+ 重试按钮；绝不显示为成功。

---

## 9. UI 验收标准

沿用 docs/UI-SPEC.md:41-47 并追加：

1. 1280×720 与 1920×1080 下社区面板含云书包页签三栏无重叠；SurfaceNav compact 抽屉切换后收起。
2. 云书包文件树、版本列表、冲突 A/B 界面均可纯键盘完成（Tab/方向键/Enter/Esc）；焦点可见；Esc 关闭所有弹窗。
3. 浅色：图标全黑 accent #111；深色：图标全白 accent #8ab4f8；DevTools Network 无外部图片请求。
4. 所有「未支持」按钮 disabled + title 含「未支持」二字；Tab 焦点跳过 disabled 控件不产生死区。
5. 冲突界面在窄窗口（社区面板 ≈360px 列宽）不破版：A/B 双栏折为上下堆叠。

## 10. 测试矩阵（Vitest，注入假 fetch）

1. 全链路：创建 → 导入 .rwmod（临时目录构造夹具，不依赖仓库外真实模组）→ blob 上传 → 提交 → diff → 发布 → 下载 → 回滚 → 分享 → 邀请成员，断言每步请求 URL/method/body 符合后端契约 §3。
2. 冲突分支：推送返回 `{success:false, code:'version_conflict', data:{headSummary}}` → 断言进入冲突 UI 而非报错弹窗；两个出口各自发出正确请求。
3. 幂等重放：同 client_op_id 二次提交 → 断言不产生第二次 versions 调用。
4. 配额/超限：`quota_exceeded`、`file_too_large` 文案与 disabled 联动。
5. 离线：offline 状态下云书包无任何写请求发出（负断言），示例数据为零。
6. IPC：7.2 表驱动白名单的命中/拒绝矩阵并入 `tests/ipc.test.ts`（含 `//host`、非白名单 path、PUT 越界、redirect 拒绝等既有用例全绿）。
7. 锚点排除：构造含 `.ohmytx/cloud.json` 的项目树跑打包，断言产物中无该文件。

## 11. 与后端的联调前置顺序

后端契约 §12 的实现顺序反向约束桌面：桌面联调最早开始于后端「M1 建表+仓库 CRUD」合入之后；冲突界面联调最后（依赖 M4 同步语义）。

## 12. 存档续跑的跨端接线契约

- 本文原先被桌面 `docs/` 忽略规则排除，文件实际存在；现显式豁免此产品契约，保证 clone/交付不丢失设计文档。
- `GET /repos/:slug/releases`：可见仓库读权限，`data.items` 最近 100 条（created_at/id DESC），含 draft/published/revoked；字段同创建响应 `data.release`。
- `GET /repos/:slug/shares`：editor+/root；token 不授予管理权限。`data.items` 最近 100 条，字段 `{id,versionNo,expiresAt,maxDownloads,downloadCount,revokedAt,createdAt}`，`versionNo:null` 表示可变 head；含已撤销/过期记录，永不返回 token/hash/URL。可见但角色不足 403，不可见/不存在 404。桌面版本页读取两列表；写管理仍走网页，刷新后从数据库加载。
- 路径首段 `..name`、`..assets/unit.ini` 合法；禁止的是独立 `..` 段、绝对/盘符路径、ADS、设备名、尾点/空格与现有危险目录。恢复的根边界按 `relative === '..' || relative.startsWith('..' + path.sep)` 断言，与网页/服务端段校验一致；符号链接与压缩包限额不放宽。
- 产品基线冻结：后端网关 `calciumion/new-api:v1.0.0-rc.37`，自有控制台使用存档旧前端，不随 New API 更新。后端 `deploy/scripts/build-product.sh` 按已锁定依赖构建旧控制台及 community，先复制 community dist 再编译内嵌二进制；Caddy 同源托管 `deploy/static/console`，API/中继另行代理。`PRODUCT-BASELINE.json` 与 `SHA256SUMS.json` 记录输入/产物，可核实加载来源；发布包包含静态控制台、许可证及该控制台 AGPL 对应源码，不包含闭源 community 源码。
- 旧控制台经 `gatewaySession.js` 适配 rc.37 Bearer access bundle、refresh cookie 与 POST logout；密码加密按该冻结版本 RSA-OAEP SHA256（长密码 v2 AES-GCM）协议。桌面/社区仍使用独立 `/api/auth` 社区会话，不将两种凭据互用。
- 隔离 UI 验收：后端 `go run -tags localqa ./cmd/localqa` 只使用新建 OS 临时 SQLite 与对象目录，仅监听 `127.0.0.1:3100`、SMTP 禁用；`LOCAL_QA_PASSWORD` 必须从环境传入随机值，账号文件只写本次临时目录且不打印密码/token。本地入口 `node deploy/scripts/local-gateway.mjs` 仅代理环回端口（3100 社区/3200 网关）并加载 staged 自有静态产物。真实 rc.37 与真实 UI 未运行时不得用协议单测代替验收。

