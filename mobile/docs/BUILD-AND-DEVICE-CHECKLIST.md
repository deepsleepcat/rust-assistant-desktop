# 出包与真机验收清单（交给电脑端 / CI）

本机（Android / Termux 沙箱）**无法产出 APK**，因此第 2、3 步需要在电脑端或 CI 上完成。
本文给出精确步骤与验收清单，避免重复踩坑。

## 1. 为什么本机不能出包（实测证据）

| 阻塞项 | 实测结果 |
| --- | --- |
| crates.io 依赖获取 | `cargo fetch --target aarch64-linux-android` 运行 40 分钟仍停在 `Updating crates.io index`，`~/.cargo/registry` 仅 22MB、**0 个 crate 下载完成** |
| 内存 | 总 5.5GB / 可用约 1GB；Rust 编译 Tauri 依赖树（400+ crate）远超此额度，链接阶段必然 OOM |
| Gradle 工程 | `src-tauri/gen/android/tauri.settings.gradle` 指向电脑端路径 `C:\Users\mao\.cargo\registry\...`，必须由 `tauri-cli` 在本机重新生成 |
| 缺失工具 | 无 Gradle、无 `sdkmanager`、无 `android.jar`（SDK platform）、无 `zipalign`、无 `adb` |

**已具备但不足以绕开上面四条**：JDK 17、`cargo` 1.98.1、`rust-std-aarch64-linux-android`、
`ndk-sysroot 30`、`aarch64-linux-android-clang`、`aapt2`、`d8`、`apksigner`。

## 2. 电脑端出包步骤

```bash
# 1) 取仓库（git 或直接拷贝 ohmytxphone/ 目录）
cd ohmytxphone
npm install
npm test                      # 期望：21 个文件 / 393 用例通过

# 2) 环境（Windows 已验证过的组合）
#    JDK 17 (Temurin)
#    Android SDK：platform-tools + platforms;android-36 + build-tools;36.0.0
#                  + NDK 27.1
#    注意：app/build.gradle.kts 里是 compileSdk = 36 / targetSdk = 36、minSdk = 24
#    rustup target add aarch64-linux-android x86_64-linux-android

# 3) 出 debug 包
npx tauri android build -d -t aarch64
# 产物：src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

首次构建需要重新编译 Rust 层：交接时排除了 `src-tauri/target/` 与
`gen/android/app/src/main/jniLibs/`（原有两个 163MB 的 debug `.so`）。
`tauri android build` 会重新生成并复制 `.so`，不需要手工干预。

## 3. 真机验收清单

准备一个**可丢弃**的测试项目（不要用真实模组），按下表逐项执行并记录结果。

### 3.1 导入导出（SAF，本机完全没验证过）

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 项目页 → 导入 → 文件夹，选一个含 `units/` 的模组目录 | 提示「已导入」，列表出现该项目，进入编辑器能看到文件树 |
| 2 | 同上但点系统选择器的返回/取消 | 提示「已取消导入」，不报错、不产生空项目目录 |
| 3 | 导入一个 `.rwmod` | 解压进应用私有目录，`mod-info.txt` 与 `units/` 都在 |
| 4 | 连续导入两个同名模组 | 第二个变成「名称2」，**第一个内容不被覆盖** |
| 5 | 项目页 → 打包按钮 → 保存到下载目录 | 提示文件数与大小；用文件管理器能找到 `.rwmod` |
| 6 | 把导出的 `.rwmod` 重新导入 | 文件清单、`mod-info.txt`、单位 ini 内容与导出前逐字节一致 |

> 第 6 项是数据完整性的关键验证；本机已用 `tests/packArchive.test.ts` 覆盖打包逻辑，
> 但**真机 SAF 读写的字节一致性必须实测**。

### 3.2 编辑与数据保护

| # | 操作 | 预期 |
| --- | --- | --- |
| 7 | 打开 `units/xxx.ini`，改内容后按系统返回键 | 弹出「还有未保存的修改」三选一；**不能直接退出** |
| 8 | 选「放弃修改」 | 回到文件树，重新打开文件确认磁盘内容没变 |
| 9 | 再改一次，选「保存并继续」 | 退出编辑；重新打开内容是新值 |
| 10 | 中文显示层开启（设置页默认为开）时打开 ini | 界面显示中文键名；保存后重新打开仍是中文；磁盘文件用文本查看器看是英文 |
| 11 | 连续保存两次 | 第二次不出现「文件已被外部修改」 |
| 12 | 保存按钮连点数次 | 只写一次盘，无异常 |

> 第 7、10、11 项分别对应本机已修的三个缺陷（未保存保护、中文回译、保存防重入）。

### 3.3 文件管理与预览

| # | 操作 | 预期 |
| --- | --- | --- |
| 13 | 目录行「⋯」→ 新建文件 `b.ini` | 出现在树里；菜单自动收起 |
| 14 | 再建一个同名 `b.ini` | 提示同名拒绝，原文件不被清空 |
| 15 | 重命名 `b.ini` → `c.ini` | 旧名消失、新名出现 |
| 16 | 删除 `c.ini` | 二次确认后消失；取消则保留 |
| 17 | 点击 `units/xxx.png` | 进入图片预览，显示像素尺寸与文件大小，可切「适应/原始」 |
| 18 | 展开一个含多级子目录的项目 | 每一级都能正常展开，**不出现「路径超出项目目录范围」** |

> 第 18 项修的是旧实现的严重缺陷（递归时项目根被替换成子目录）。

### 3.4 检查与定位

| # | 操作 | 预期 |
| --- | --- | --- |
| 19 | 检查页运行检查 | 结果列表带文件与行号 |
| 20 | 点某条结果 | 打开该文件并**跳到对应行** |
| 21 | 检查未完成时切换项目 | 不显示上一个项目的结果（本机已加版本守卫，需真机确认） |

### 3.5 交互与键盘

| # | 操作 | 预期 |
| --- | --- | --- |
| 22 | 编辑器工具栏：撤销/重做/搜索/缩进/符号/补全 | 每个按钮都生效 |
| 23 | 点工具栏按钮 | 软键盘**不收起**，插入落在光标处 |
| 24 | 中文输入法输入 | 组合期间不被工具栏命令打断 |
| 25 | 软键盘弹起时 | 工具栏与保存按钮仍可见可点（`--app-viewport-height` 兜底） |
| 26 | 横屏 / 平板上操作 | 布局不破，弹层居中，触控目标不小于 44px |

### 3.6 示例项目

| # | 操作 | 预期 |
| --- | --- | --- |
| 27 | 项目页 → 创建示例项目 | 生成「示例项目」并进入编辑器，含 `mod-info.txt`、`units/sampleTank.ini`、两张 PNG |
| 28 | 再创建一次 | 得到「示例项目2」，**不覆盖**上一个 |
| 29 | 点开示例项目里的 PNG | 能预览（占位图，32×32） |

## 4. 结果回传

请按下面格式回报，便于定位：

```
机型 / Android 版本：
APK 来源（构建命令）：
通过项：3.1#1-6、3.2#7-12 …
失败项：#N 操作 → 实际现象 → 截图/日志
补充观察：
```

失败时附上 `adb logcat | grep -i -E 'tauri|ohmytx|Rust'` 的相关片段。

## 5. 已知会在真机暴露、但本机无法预判的点

1. **SAF 返回的是 `content://` 还是文件路径**：现有实现假定 `plugin-dialog` 返回可直接读写的路径。
   若真机返回 `content://URI`，`plugin-fs` 的直接读写会失败 —— 那时需要给
   `src/services/bridge.ts` 增加 `ContentResolver` 适配层（选择、读入托管目录、导出流），
   这是本批**唯一预留了但没实现**的适配点。
2. **`window.history` 返回键接管**：Android WebView 的返回键行为需实机确认；
   若返回键不经过 `history.back()`，需要改用原生返回键通道。
3. **`visualViewport` 的软键盘表现**：不同厂商 WebView 差异大，第 25 项需要如实记录。
