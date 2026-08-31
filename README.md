# codex-hud

一个只在 Codex 桌面窗口内部显示的 Token 悬浮 HUD。

## 包含内容

- `start-codex-hud.vbs`：双击入口，无控制台窗口。
- `codex-hud.ps1`：最小启动器，负责启动/附加 Codex、读取当前任务 Token 和 CDP 注入。
- `hud.js`：注入 Codex renderer 的 HUD 显示逻辑。
- `config.json`：CDP 端口、轮询周期和本地费用估算价格。
- `logs/launcher.log`：仅记录启动和注入状态，不记录对话内容或认证信息。

不包含 helper、HTTP 服务、外部窗口、托盘、Profile、统计页面或第三方接口。

## 使用

1. 完全退出当前 Codex 和 Codex++。任务栏托盘或任务管理器中不应再有 Codex 主窗口进程。
2. 双击 `start-codex-hud.vbs`。
3. Codex 会正常打开，HUD 默认出现在窗口右下方。
4. 拖动 HUD 标题栏可以移动；点击 `-` 可以折叠。

启动器从 Codex 侧栏当前选中的任务 ID 定位对应的本地 `rollout-*.jsonl`，只提取模型名和 `token_count` 记录，再通过 CDP 更新 HUD。它不会启动本地 HTTP 服务。

`config.json` 中的 `hotReload` 控制 `hud.js` 热更新。设为 `true` 时，保持启动器运行并修改该文件，启动器会在一个轮询周期内重新注入 HUD；设为 `false` 时，仅在启动时读取一次。该开关不影响 Token 数据轮询，轮询周期由 `pollIntervalMs` 控制。

如果 Codex 已经通过其他启动器开启了本机 CDP，本启动器会直接附加，而不会再启动一个实例。

## 排错

HUD 没出现时查看 `logs/launcher.log`。

常见情况：

- `Codex is already running without CDP`：完全退出 Codex后重新双击入口。
- `Configured CDP port ... is already in use`：修改 `config.json` 中的 `debugPort`。
- `Timed out waiting for the Codex renderer`：确认 Microsoft Store Codex 可以正常启动，然后重试。

## 费用说明

费用是按 `config.json` 中的 USD / 1M tokens 价格计算的本地估算，不代表 ChatGPT/Codex 套餐的实际账单。模型价格变化时可直接修改该文件。

## 安全边界

- 启动参数将 Chromium DevTools Protocol 绑定到 `127.0.0.1`。
- 启动器拒绝连接非回环地址或端口不匹配的 CDP WebSocket。
- 启动器不读取或上传 API key、cookie、会话正文和认证数据，只解析当前任务日志中的模型名和 Token 统计字段。
- Codex 更新如果改变侧栏任务属性或本地 `token_count` 格式，HUD 的定位逻辑可能需要同步更新。
