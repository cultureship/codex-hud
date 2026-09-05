# codex-hud

<p align="center">
  <strong>中文</strong> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <strong>通过 CDP 注入到 Codex Desktop 内部的 Token 与 Cost HUD，适用于 Sub2API</strong><br>
</p>

本项目非官方，不会修改 Codex 安装文件，也不会创建外部窗口、托盘、HTTP 服务或独立统计页面。
启动器会在本机启动或附加启用 CDP 的 Codex renderer，并根据本地会话记录更新 HUD。

## 功能

- 显示本轮输入、输出和费用，并在一轮对话中持续累计
- 显示当前会话 Token、缓存命中率和会话费用
- 使用本地账本保留今日与本周费用，会话归档或删除后仍可统计
- 支持两种 UI 模板、透明背景
- 支持 `hud.js` 热更新，可更改调试个性化的样式与模块
- 支持全局费用倍率

## UI 模板

在 `config.json` 中通过 `uiTemplate` 选择界面：

| 值 | 界面 |
| --- | --- |
| `1` | 可拖动的浮动 HUD，位置保存在 Codex 的本地存储中 |
| `2` | 固定在底部输入框上方的横向数据栏，按本轮 Token、费用和周期费用分组 |

`transparent: true` 会在普通会话中隐藏面板背景、边框和阴影，仅保留数据与模板 2 的组间分隔线

New chat 始终使用不透明样式

## 效果展示

<p align="center">
  <img src="images/new_chat_dark.png" alt="New chat 深色主题">
  <img src="images/new_chat_light.png" alt="New chat 浅色主题">
  <br><sub>New Chat</sub>
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_170634_329.png" alt="HUD 效果 3">
  <br><sub>会话还没获得数据时显示 <code>...</code></sub>
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_170644_273.png" alt="HUD 效果 4">
  <br><sub>获得数据但未结束时显示 <code>activeTurnColor</code> 设置的颜色</sub>
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_171318_810.png" alt="HUD 效果 5">
  <br><sub>会话结束显示白色</sub>
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_171443_765.png" alt="HUD 效果 6">
  <br><sub>在已有内容的会话继续对话</sub>
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_171623_794.png" alt="HUD 效果 7">
  <br><sub><code>transparent: true</code> 的效果</sub>
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_171651_517.png" alt="HUD 效果 8">
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_172012_769.png" alt="HUD 效果 9">
  <br><sub><code>transparent: false</code> 的效果</sub>
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_172028_437.png" alt="HUD 效果 10">
  <img src="images/ScreenShot_2026-09-01_172108_510.png" alt="HUD 效果 11">
</p>

<p align="center">
  <img src="images/ScreenShot_2026-09-01_175115_694.png" alt="HUD 效果 12">
  <img src="images/ScreenShot_2026-09-01_175843_653.png" alt="HUD 效果 13">
  <br><sub>UI 模板 1</sub>
</p>

## 环境

- Windows 10 或 Windows 11
- Windows PowerShell 5.1
- 本机可用的回环 CDP 端口，默认使用 `9335`

## 快速开始

1. 克隆本仓库，推荐放在用户目录下

   ```text
   git clone https://github.com/cultureship/codex-hud.git
   ```

2. 如果 Codex 已经运行但没有启用 CDP，需要先完全退出
3. 双击 `start-codex-hud.vbs`
4. 启动器以隐藏窗口运行，并使用 `127.0.0.1` 上的 CDP 启动或附加 Codex

如果 Codex 已经由其他本地启动器使用同一 CDP 端口启动，本项目会直接附加该实例

如果只想附加已经启用 CDP 的 Codex，可以双击 `attach-codex-hud.vbs`
这个入口不会启动 Codex，目标实例不存在或未启用 CDP 时会直接退出并将原因写入 `launcher.log`

也可以使用指向 `start-codex-hud.vbs` 的 `.lnk` 快捷方式，移动项目文件夹后需要更新快捷方式的目标路径

## 配置

所有设置都位于 `config.json`：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `debugPort` | number | Codex 的本机 CDP 端口，范围为 `1024-65535` |
| `pollIntervalMs` | number | Token 刷新、热更新检查和异常恢复的回退周期，最小为 `1000` 毫秒 |
| `hotReload` | boolean | 是否在运行期间检测并重新注入修改后的 `hud.js` |
| `cleanupOldLogs` | boolean | 启动时是否清理 `launcher.log` 中超过 7 天的记录 |
| `cleanupOldLedger` | boolean | 是否只保留本周和上周的账本记录 |
| `uiTemplate` | number | HUD 模板，允许值为 `1` 或 `2` |
| `transparent` | boolean | 是否隐藏 HUD 背景、外边框和阴影 |
| `priceMultiplier` | number | 应用于所有模型费用结果的全局倍率 |
| `activeTurnColor` | string | 当前轮次正在生成时的数值颜色，接受有效 CSS 颜色 |
| `longContextThresholdTokens` | number | 单次请求进入长上下文价格档的输入 Token 阈值 |
| `codexPath` | string | 可选的 Codex 可执行文件路径；留空时自动寻找支持的 Microsoft Store 包 |
| `prices` | object | 各模型每 100 万 Token 的输入、缓存输入、输出及长上下文价格 |

修改 `config.json` 后需要重新启动 HUD 启动器
`hotReload` 只负责重新载入 `hud.js`

## 数据含义

| HUD 字段 | 含义 |
| --- | --- |
| `input` | 当前一轮用户对话累计产生的输入 Token |
| `output` | 当前一轮用户对话累计产生的输出 Token |
| `session` | 当前会话累计 Token |
| `cache` | 当前会话缓存输入占输入 Token 的比例 |
| `turn` | 当前一轮对话的本地费用估算 |
| `session cost` | 当前会话的本地费用估算 |
| `today` | 本地账本记录的今日费用 |
| `week` | 本地账本记录的本周费用 |

### 显示状态

| 显示 | 含义 |
| --- | --- |
| `...` | 新一轮已经开始，但尚未获得 Token 数据 |
| 黄色数值 | 当前轮次正在运行，并且已经获得部分 Token 数据 |
| 白色数值 | 当前轮次已经正常结束或被中止，显示结束前最后获得的数据 |
| `--` | New chat、空会话或当前会话尚无可用 Token 数据 |

费用仅根据本地 Token 数据和 `config.json` 中的价格计算，不代表 ChatGPT 或 Codex 套餐的实际账单

## 工作方式

1. 启动器使用仅绑定到 `127.0.0.1` 的 CDP 启动或附加 Codex
2. 侧栏监听器取得当前选中会话的 ID，创建新会话时也会从新 rollout 的 `session_id` 直接完成绑定
3. 启动器从用户目录下的 `.codex/sessions` 定位对应 `rollout-*.jsonl`
4. 解析器只提取模型、轮次状态和 `token_count` 数据，并维护增量读取位置
5. 分页会话会沿 `history_base` 合并计费数据，父记录已经删除时使用累计 Token 基线补齐
6. 数据通过 CDP 传入 Codex renderer，由 `hud.js` 更新内部 HUD

文件变化监听用于快速更新当前轮次
`pollIntervalMs` 保留为异常恢复和回退机制


## 项目文件

| 文件 | 用途 |
| --- | --- |
| `start-codex-hud.vbs` | 无控制台窗口的双击启动入口 |
| `attach-codex-hud.vbs` | 只附加已运行 CDP Codex 的无窗口入口，不会启动 Codex |
| `start-codex-hud-openai.lnk` | 使用 OpenAI 图标的示例快捷方式，移动项目后需要更新目标路径 |
| `codex-hud.ps1` | Codex 启动、CDP 附加、会话定位、账本和注入逻辑 |
| `hud.js` | HUD 状态、渲染、两种 UI 模板和页面内数据捕获 |
| `config.json` | 运行参数、UI 设置和模型价格 |
| `usage-ledger.json` | 运行时生成的本地费用账本，不保存对话正文 |
| `launcher.log` | 运行时生成的启动和注入日志 |

## 日志与账本

`launcher.log` 只记录启动、附加、同步和错误状态
启用 `cleanupOldLogs` 时，每次启动会删除超过 7 天的日志记录

`usage-ledger.json` 保存请求时间、模型、Token 分类和去重键，用于计算今日及本周费用
启用 `cleanupOldLedger` 时，启动器只保留本周和上周记录，自动删除上上周及更早的数据

## 排错

### Codex 已运行但 HUD 没有出现

如果 `launcher.log` 包含：

```text
Codex is already running without CDP
```

完全退出 Codex，再双击 `start-codex-hud.vbs`
CDP 参数只能在 Codex 启动时添加

### 配置端口已被占用

如果日志包含 `Configured CDP port ... is already in use`，确认占用该端口的程序是否为需要共享的 Codex CDP 实例
否则修改 `debugPort` 后重新启动

### HUD 显示 `--`、`...` 或数据没有及时更新

- `...` 表示当前轮次已经开始但尚未获得 Token 数据
- `--` 表示 New chat、空会话或当前会话没有可用 Token 数据
- 检查 `launcher.log` 是否成功绑定当前会话并显示 `rollout usage loaded=True`
- 确认 Codex 更新后 `.codex/sessions` 中仍包含 `token_count` 记录

### 修改配置后没有生效

停止并重新运行 `start-codex-hud.vbs`
配置只在启动时读取，运行期间的热更新仅适用于 `hud.js`

## Issue

提交 Issue 时请附上复现步骤、必要的 `launcher.log` 日志和脱敏后的 `config.json`

## 隐私与安全

- CDP 只绑定到 `127.0.0.1`
- 启动器拒绝连接非回环地址或端口不匹配的 WebSocket
- 不读取或上传 API key、Cookie 和认证信息
- 不保存或上传会话正文
- 不启动 HTTP 服务，不提供外部 UI，不连接第三方统计接口
- 本地账本只包含费用统计所需的时间、模型、Token 和去重字段

## 已知限制

- Codex Desktop 更新可能改变 renderer DOM、侧栏属性或本地 `token_count` 格式，届时挂载和解析规则可能需要同步调整
- 今日与本周费用是本地账本估算，删除 `usage-ledger.json` 后无法从已删除的历史会话恢复对应统计
- 启动器运行期间不要让另一个程序以不同端口重复启动同一 Codex 实例
