# dsh-tui-attach

把**正在运行的** DeepSeek Harness（Desktop / Web Host）接到终端里操作。

它不是再启动一个 harness：Host 插件把当前进程的 `sessionController` 通过本机 Unix socket 暴露出来，`dsh-attach` 连上去以后看到的是**同一批 Session、同一个正在跑的 Agent、同一套审批和提问**。你在 TUI 里发的 prompt 会直接进入当前 Host；Web GUI 里也能看到同一轮对话。

```
┌──────────────────────────────┐        Unix socket (0600)        ┌───────────────────────┐
│ DeepSeek Harness Host 进程     │◀────────────────────────────────▶│ dsh-attach (终端)      │
│  sessionController            │   JSONL: request / response      │  pi-tui alternate UI  │
│  approval / user-questions    │   session frames / interactive   │  key/commands         │
└──────────────────────────────┘                                  └───────────────────────┘
```

没有 TCP 监听、没有额外端口、没有新的登录 token；socket 和描述文件都在 `$DSH_HOME/tui-attach/`，只有当前用户可读写。

## 功能

- **接入同一个 Host**：列出、恢复、创建 Session；读取持久化历史，订阅实时 token / 思考 / 工具调用
- **直接对话**：流式 Markdown、代码块、思考折叠、工具调用与结果、turn/step 状态、token/上下文/权限状态栏
- **浅色优先**：默认浅色主题（适合白色/浅色终端），`--theme dark` 切回深色
- **列表可搜索**：Session / 模型选择器支持 `Ctrl+N`/`Ctrl+P`、`↑/↓` 移动，`/` 或直接输入增量过滤；输入单个 `/` 就展开命令列表
- **Session 按 Workspace 分组**：树状组头、可折叠；旧 Host 没有 Workspace API 时按 cwd 分组
- **Subagent 浏览**：父 Session 显示子 agent 数，`/agents` 列出谱系，打开为只读历史，`/parent` 返回
- **命令自动补全**：输入 `/` 弹出本地命令 + Host `ctx.commands` 注册的命令；`/resume`、`/model` 补全参数；相对文件路径也能补全
- **补全浮层在输入框上方**：不占用编辑器高度，弹出/收起不会推动输入框或重排布局
- **Emacs 键位**：`Ctrl+N/P` 上下移动（输入框、补全、选择器、提问选项），`Ctrl+A/E/B/F` 行/字符移动，`Ctrl+K/U/W/Y` 删除与 yank
- **审批**：`approval/request` 以面板出现，`y` 允许一次、`n` 拒绝；**默认**只要 TUI 正在看这个 Session 就由 TUI 回答，超过 grace 未回答才交回 Web GUI
- **提问**：`ask_user_question` 支持单选、多选、自定义文本、计划审批；`Esc` 收起、`s` 跳过后立即返回 pending
- **会话/模型**：`/sessions`、`/new`、`/rename`、`/model`、`/status`
- **Host 命令直通**：`/compact`、`/goal` 等不认识的 slash command 原样交给 Host
- **安全**：本机 Unix socket + 32 字节随机 token + `timingSafeEqual`；模型/工具输出会剔除 ANSI/OSC 控制序列，防止终端注入

## 安装

### 1. 安装 Host 插件

在仓库根目录：

```sh
dsh plugin --profile desktop add ./dsh-tui-attach
```

或者从 tarball / npm 包安装（`pnpm pack` 后）：

```sh
dsh plugin --profile desktop add ./dsh-tui-attach-0.14.0.tgz
```

`dsh plugin` 会把包加到 profile 的 `dsh.profile.bundles` 并安装依赖。**安装后重启 DeepSeek Harness**（Desktop 的插件安装可能需要重启才会挂载新的 bundle）。

> 如果你在 Web profile 里用：`dsh plugin --profile web add ./dsh-tui-attach`，然后重启 `dsh web`。

### 2. 让 `dsh-attach` 在 PATH 里

安装完成后客户端在 profile 的 `.bin` 下：

```sh
~/.dsh/profiles/desktop/node_modules/.bin/dsh-attach --help
```

建议做个软链接（`~/.local/bin` 通常已在 PATH）：

```sh
ln -sf ~/.dsh/profiles/desktop/node_modules/.bin/dsh-attach ~/.local/bin/dsh-attach
```

### 3. 启动

```sh
dsh-attach              # 交互式选择 Session
dsh-attach --list       # 只列出 Session
dsh-attach -s <id>      # 直接打开某个 Session
dsh-attach --new -p "run the tests"
dsh-attach --theme dark   # 深色终端
```

## 键位与命令

| 键 / 命令 | 作用 |
|---|---|
| `Enter` | 发送 prompt（运行中默认排队） |
| `/steer <text>` | 中断当前 turn 并插入 steer 消息 |
| `/queue <text>` | 运行中排队一条消息 |
| `/sessions`, `/resume` | 打开 Session 选择器 |
| `/new [cwd]` | 在当前目录（或指定目录）新建 Session |
| `/rename <title>` | 重命名 Session |
| `/model` | 选择 provider/model |
| `/status` | 查看 session、模型、上下文、token、todo、goal、socket |
| `/cancel` | 取消当前 turn |
| `/help` | 帮助 |
| `/quit`, `Ctrl+C` | 退出（不会停止 Host 里已经在跑的任务） |
| `Ctrl+T` | 展开/折叠思考 |
| `Ctrl+O` | 展开/折叠工具参数与输出 |
| `Ctrl+L` | 滚回底部 |
| `Ctrl+N` / `Ctrl+P` | 下 / 上移动（输入框光标、补全列表、选择器、提问选项） |
| `Ctrl+A` / `Ctrl+E` / `Ctrl+B` / `Ctrl+F` | 行首 / 行尾 / 左 / 右 |
| `Ctrl+K` / `Ctrl+U` / `Ctrl+W` / `Ctrl+Y` | 删到行尾 / 行首 / 前一个词 / yank |
| 列表页 `Ctrl+N` / `Ctrl+P`, `↑` / `↓` | 上下移动 |
| 列表页 `/` 或直接输入 | 增量搜索（过滤标题、cwd、描述、provider/model） |
| 列表页 `Enter` | 选中 |
| 列表页 `Ctrl+U` / `Ctrl+W` | 清空搜索 / 删除一个词 |
| 列表页 `Esc` | 退出搜索并清空过滤；再按一次取消 |
| 正文 `PgUp` / `PgDn` | 上/下翻一页消息历史（也支持 `Shift+PgUp/PgDn`、`Ctrl+V`/`Alt+V`、`Ctrl+Alt+F`/`Ctrl+Alt+B`） |
| 正文 `Ctrl+Home` / `Ctrl+End` | 跳到历史顶部 / 底部 |
| 正文 `Ctrl+L` | 回到最新消息并恢复自动跟随 |
| 正文鼠标滚轮 | 滚动历史（滚上去后不会被新消息拉回底部） |
| 输入框 `↑` / `Ctrl+P` | 上一条已提交的 prompt（本次运行内，最多 100 条） |
| 输入框 `↓` / `Ctrl+N` | 下一条 prompt；回到正在编辑的草稿 |
| 组头 `Enter` / `→` / `←` | 展开/折叠 Workspace 组 |
| `↑/↓`, `PageUp/PageDown`, 鼠标滚轮 | 浏览 transcript |
| `y` / `n`（审批） | 允许一次 / 拒绝 |
| `↑/↓`, `Space`, `Enter`, `c`（提问） | 选项、多选、下一题、自定义文本 |
| `s`（提问） | 跳过整批问题并立即给 Host 返回 skipped |
| `Esc`（提问） | 收起面板（问题保持可回答，直到超时或 Web 端回答） |

### 命令补全

- 行首输入 `/` 自动弹出命令菜单；继续输入会模糊过滤
- **`Tab`**：补全到输入框，不执行
- **`Enter`**：补全并立即执行（参数类命令建议先用 `Tab` 再输入参数）
- 补全列表浮在输入框上方，不改变编辑器高度，因此不会把输入框顶上去

### 翻阅历史

TUI 打开 Session 时会加载最近 300 条消息。`PgUp`/`PgDn`、`Shift+PgUp/PgDn`、`Ctrl+V`/`Alt+V`、鼠标滚轮都可以滚动；`Ctrl+L` 回到最新并恢复自动跟随。滚到历史里时，新到达的流式消息不会把视图拉回底部。

更早的分页（超过 300 条）暂未接入；输入框里的 prompt 历史是本次运行内的，不跨重启持久化。

### 长时间使用性能

0.11.8 起针对“界面开久了越来越卡”继续收紧了输入路径（0.11.6 起已有行级缓存和 transcript 上限）：

- **行级渲染缓存**：历史消息、工具卡片和 reasoning 只在文本、展开状态或终端宽度变化时重新排版；普通按键不会再重新 wrap 全部历史。流式回答只重排当前正在增长的那一行。
- **有界 transcript**：跟随底部时最多保留 8000 行；超出后丢弃最旧的行，避免内存和每帧遍历无限增长。向上翻历史时不会裁剪，避免滚动位置跳动。
- **subagent 状态刷新节流**：新 Host 用轻量 `subagent.summary`，约 1 秒防抖 + 4 秒轮询；旧 Host 降到约 12 秒一次，且父 turn 运行期间不因每个 tool result 全量拉 session.list；数量/状态没变时不重绘、不上报 Herdr。
- **默认只开 button-motion 鼠标**：关闭 `1003` all-motion tracking，滚轮/点击/拖选保留，避免 Herdr/iTerm2 的高频鼠标移动事件占满输入循环；需要时用 `DSH_ATTACH_FULL_MOUSE=1` 开回。
- **超长流式回答**：超过 40k 字符时，实时阶段只渲染尾部纯文本，finalize 时再完整跑一次 Markdown，避免一个不断增长的消息把每次 streaming tick 拖成秒级。

本地合成的 900 行混合 transcript 基准：未缓存约 25ms/帧，缓存后约 0.1ms/帧（同一进程、同一宽度）。实际长会话（约 300 条消息）用 `DSH_ATTACH_PERF=1` 测到的 warm 状态约 2.5ms/帧。

想自己确认：

```sh
DSH_ATTACH_PERF=1 dsh-attach -s <session-id>
# 每 50 帧写 frame-stats（avg/max/heap）
# 每次按键写 input-latency，事件循环超过 100ms 写 loop-lag
```

Host 0.11.7 起提供轻量 `subagent.summary`（只返回计数），避免每 4 秒把 800 条 Session JSON 传进 TUI 进程解析；旧 Host 自动回退到 `session.list`。

### 终端失焦

终端发送 `focus-out` 时，输入框里表示空输入的块状光标会隐藏；`focus-in` 后恢复。这样切到别的应用时不会留下一个像“占位符”的亮块。只在终端支持 focus reporting 时生效（默认鼠标模式会开启；`DSH_ATTACH_NO_MOUSE=1` 时不会）。

### 客户端退出诊断

0.11.2 起客户端会写生命周期日志（默认 `$DSH_HOME/tui-attach/client.log`，0600，超过 2MB 轮转）：

```sh
tail -f ~/.dsh/tui-attach/client.log
```

日志只记录 pid、argv（`--token` 已脱敏）、终端环境、session 打开、focus 状态、信号、quit 原因、未捕获异常和退出码；不会记录 prompt 正文。focus 日志按 2 秒节流，并在下一条里带 `suppressed` 计数。`--log <file>` 可改路径，`--log off` 或 `DSH_ATTACH_LOG=off` 可关闭。

常见 quit 原因：

| reason / 日志 | 含义 |
|---|---|
| `quit reason=ctrl+c` | 收到了 Ctrl+C 字节（用户按了，或终端/脚本发送） |
| `quit reason=picker-empty` | 旧版本：初始 Session 选择器被 Esc 关闭；0.11.2 起改为提示，不再退出 |
| `quit reason=command` | `/quit` 或 `/exit` |
| `signal signal=SIGHUP` | 终端/tmux/Herdr/SSH 挂断，不是 TUI 逻辑 |
| `signal signal=SIGTERM` / `SIGINT` | 被外部进程终止 |
| `stdin-end` / `stdin-close` | 终端 pty 关闭；0.11.9 起两者都会走 `quit` 并留下记录 |
| `before-exit` | 事件循环即将自然退出，但没有经过 `quit`，可用于发现静默路径 |
| `uncaughtException` / `unhandledRejection` | JS 异常，日志里有 stack |
| `process-exit code=...` | 最终退出码 |

退出码：`129` = SIGHUP，`130` = SIGINT，`131` = SIGQUIT，`143` = SIGTERM，`137` = SIGKILL（通常没有日志）。

如果日志里**完全没有退出记录**，可能是 SIGKILL、终端/系统崩溃、`DSH_ATTACH_LOG=off`/不可写，或进程在 AttachApp 构造前就退出（连接失败、无 TTY）；用 shell wrapper 捕获状态：

```sh
while :; do
  dsh-attach -s <session-id>
  code=$?
  printf '%s exit=%s\n' "$(date '+%F %T')" "$code" | tee -a ~/.dsh/tui-attach/exit.log
  [ "$code" -eq 0 ] && break
  sleep 1
done
```

定位 focus 相关问题时：

- `focus {"state":"out"}` / `focus {"state":"in"}` 日志表示终端确实发送了焦点事件；日志按 2 秒节流，`suppressed` 是期间被合并的次数。focus 事件在 viewport 层被消费，不会变成 Esc 或关闭弹窗
- `DSH_ATTACH_NO_MOUSE=1 dsh-attach ...` 禁用鼠标和 focus reporting；如果不再退出，问题在焦点/鼠标上报路径
- `DSH_ATTACH_KEYS=1` 会记录原始按键（**可能包含输入内容，仅临时排障用**）
- 在 tmux 里复现、在 iTerm2 直接运行、在 Herdr pane 里运行，三者对比可以区分是终端、tmux 还是 Herdr 触发
- 初始 Session 选择器按 Esc 现在只会关掉选择器并提示，不再退出；显式退出用 `Ctrl+C`

### Herdr

在 [Herdr](https://herdr.dev/) 的 pane 里直接运行 `dsh-attach` 即可，不需要 `herdr integration install`，也不需要改 Herdr：

- 自动向 Herdr 上报 `dsh` agent 的 `idle` / `working` / `blocked`
  - `working`：有 turn 在跑，**或还有 subagent 在运行**（任意层级，即使父 turn 已结束）
  - `blocked`：审批或提问面板正在等待回答
  - `idle`：父 turn 和所有 subagent 都空闲，可以接受输入
- 上报 resume command：`dsh-attach --reattach <session-id>`（带上原来的 `--profile` / `--endpoint` / `--theme dark`）
- TUI 退出时释放 pane，不留下幽灵 agent
- `blocked` 会带一条简短说明，例如 `bash approval: ...`，Herdr 的 `herdr agent wait` 可以等它

要求：

- Herdr 0.9.2+ 才会使用 resume command；更早版本只使用状态上报
- `dsh-attach` 在 `PATH` 上（resume command 的第一个词必须是普通命令名）
- resume 只重启 TUI 客户端，DSH Host（桌面 App）本身要还在运行；机器重启后 Herdr 恢复 pane 时，如果 Host 没起来，resume 会连不上
- 当前实现依赖 Herdr 注入的 `HERDR_ENV=1`、`HERDR_PANE_ID`、`HERDR_BIN_PATH`；普通终端里完全 no-op

### 默认 subagent peek

有活跃 subagent 时，父 TUI 底部默认显示最多 2 个的轻量 peek：

```text
◈ reviewer running
  ⚙ bash npm test
  ✓ 24 passed
◈ builder running
  … editing src/foo.ts
```

- 每个 peek 只保留最近 **2 行**，不渲染完整 transcript/Markdown
- 每个 peek 是一个**额外的 Unix socket 连接**，不是新进程；最多 2 个
- 文本提取最多 10 次/秒，父界面重绘最多约 3 次/秒
- subagent 不再 running、切换 Session、关闭 `/peek` 或退出时自动断开
- `/peek` 可开关；默认开启
- Host 0.13+ 的 `subagent.summary` 返回 active ID；旧 Host 用 `session.list` 回退
- 想看完整执行内容仍用 `/agents` 或 `/agents-preview`

### 多 subagent 预览（Herdr）

在 Herdr pane 里运行父 `dsh-attach` 时：

```text
/agents-preview        # 默认最多 2 个 running subagent
/agents-preview 1      # 只开 1 个
```

行为：

- 只对当前 Session 谱系下 **running** 的 subagent 开 pane；每次调用最多开 2 个，重复执行会再开新的 pane
- 默认最多 2 个，避免 19 行高的 pane 被切碎
- 第一次 split 当前 pane（宽时向右，窄时向下），后续 split 上一个 preview pane
- 使用 `--no-focus`，父 TUI 保持焦点
- 每个 pane 运行：
  ```sh
  dsh-attach --preview <child-id> --parent <parent-id>
  ```
- preview 模式是独立的轻量渲染器：无编辑器、补全、审批、轮询或 Herdr agent 上报
- 支持 `PgUp` / `PgDn` / `End` 滚动，`Ctrl+C` 关闭
- preview pane 不会自动关闭，留在那里供查看；关闭它不会影响 subagent
- 不在 Herdr 里时提示改用 `/agents`

`--preview` 也可以单独用：

```sh
dsh-attach --preview <child-session-id> --parent <parent-session-id>
```

### Subagents

父 Session 的描述里会显示整个子 agent 谱系的数量，运行中时显示 `1/27 agents` 这样的运行/总数。打开父 Session 后，**header 标题旁**和 activity 行都会持续显示：

- `● DSH · orchestrator · agents 1/27`：header 徽标
- `● subagents running · agents 1/27`：父 turn 已结束但仍有子 agent 活跃
- `✻ working · turn 12 · agents 1/27`：父 turn 自己也在跑
- 全部空闲时 activity 显示 `agents 27 idle`

`/agents` 列出当前 Session 谱系下的 subagent：**运行中的在前，同状态内按最近更新倒序**；缩进表示嵌套深度，回车打开，标题会显示运行中的数量。子 agent 计数来自 session list 并按 parent 链归到顶层 Session，不依赖 Host 的 catalog 路由，因此旧 Host 也可用。

- subagent 历史以**只读**方式浏览，footer 会标记 `subagent · read-only`
- `/parent` 返回直接父 Session
- 打开 subagent 历史需要 Host 0.10.0（重启 App）；列表和数量在旧 Host 上也可用
- 暂不支持从 TUI 派发 subagent，也不支持继续/中断 continuable child；这些仍通过主 agent 的委派工具或 Web UI 完成

### 重新 attach（不是 resume）

`dsh-attach` 是 attach 到一个已经存在的 Host，不是启动一个新 Agent，所以退出提示用 **Reattach**：

```text
Reattach with: dsh-attach --reattach <session-id>
```

- 只在正常退出（`Ctrl+C`、`/quit`、`/exit`）且当前有 Session 时打印
- 信号退出、stdin 关闭、异常退出不打印（终端可能已经不在了）
- `--reattach <id>` 是 `--session <id>` 的别名
- 会带上原来的 `--profile` / `--endpoint` / `--theme dark`
- `DSH_ATTACH_NO_EXIT_HINT=1` 可关闭
- 和 `/resume` 的区别：`/resume` 是选择器，`--reattach` 直接回到指定 Session

### Session 树

0.9.0 起 Session 选择器按 Workspace 分组：组头显示 Workspace 标题和路径，Session 缩进显示在组内。默认只展开当前 Session、运行中的 Session 和最近使用的组；搜索时自动展开匹配的组，`Enter` / `→` / `←` 可手动折叠展开。

Host 没有 `workspaceController`（例如仍在运行的旧 Host）时，客户端按 `cwd` 分组，功能不受影响；重启 App 后会自动使用真正的 Workspace 标题和成员顺序。
- `/resume ` 补全 Session 标题/id；`/model ` 补全 provider/model
- 普通文件路径（如 `./src/`、`../`）也有补全（基于当前 Session 的 cwd）；`@` 文件索引暂未接入
- 本地命令由 TUI 处理；Host 注册的命令通过 Host 的 `ctx.commands.execute` 执行，**不会变成模型 prompt**
- 不认识的 `/xxx` 会先尝试 Host 命令注册表，失败后按普通 prompt 交给 Host

> 如果当前运行中的 Host 还是安装前的旧插件构建，客户端会提示重启一次：本地命令补全立即可用，Host 命令（`/compact`、`/goal` 等）会在重启后出现并可执行。

### Attach 时补发 pending 审批

0.8.0 起，Host 会把尚未 `approval/decided` 的审批和尚未回答的提问保留在内存里。TUI **在请求发出之后才 attach** 到该 Session 时，也会立即收到补发的面板，而不是只看到历史里的黄色提示。

如果 Web UI 同时持有同一个请求，TUI 先回答会让工具继续执行；Web 端的面板可能残留，刷新或忽略即可。

旧 Host（例如仍在运行的 0.1.0 插件）不会补发，也不会广播。必须重启一次 DeepSeek Harness 让 Host 加载 0.8.0。

### 多个 TUI 窗口

0.8.0 起，审批/提问会**广播给所有正在看这个 Session 的 TUI 窗口**，先回答的那个生效，其他窗口的面板会自动关闭。旧 Host 只会把请求发给其中一个连接；如果同时开了多个 `dsh-attach`，请先只保留一个窗口，或重启 App 加载 0.8.0 Host。



## 主题

默认 `light`：深色前景色（accent 25、green 28、red 160、panel bg 254），适合浅色终端。深色终端用：

```sh
dsh-attach --theme dark
# 或
DSH_ATTACH_THEME=dark dsh-attach
```

主题只影响客户端渲染，不影响 Host。

## 配置

在 profile 的 `cordis.patch.yml` 里按 entry id 覆盖：

```yaml
- id: tui-attach
  config:
    enabled: true
    # socketPath: /custom/path.sock
    approvals: tui         # tui (默认) | auto | web | off
    questions: tui         # tui (默认) | auto | web | off
    activeWindowMinutes: 10   # 仅 auto 模式使用
    approvalGraceSeconds: 120
    questionGraceSeconds: 300
```

- `tui`（默认）：只要 TUI 正在看这个 Session 就给 TUI；客户端每 20 秒发一次 activity 心跳，长 turn 期间也不会因为“最近没操作”而被判给 Web。超过 grace 仍未回答才交回 Web。
- `auto`：兼容旧行为的启发式：TUI 在 `activeWindowMinutes` 内有过操作，或 Web 不在线时给 TUI；否则交给 Web。
- `web`：完全不拦截，全部由 Web GUI 处理。
- `off`：关闭 TUI 审批/提问。
- `approvalGraceSeconds` / `questionGraceSeconds`：TUI 弹窗后多久没回答就交回 Web；`0` 表示一直等。
- `enabled: false`：不启动 socket，但仍保留插件。

## 安全模型

- socket 在 `$DSH_HOME/tui-attach/attach-<pid>.sock`，目录 `0700`、socket `0600`、描述文件 `0600`
- 客户端第一条消息必须带描述文件里的 32 字节随机 token，Host 用 SHA-256 + `timingSafeEqual` 校验
- 不监听 TCP；不会把 Host 暴露到局域网
- TUI 拥有和当前用户相同的 Session/Agent 权限。**能连上 socket 就等于能操作这个 Harness**
- 模型输出、工具输出、问题文本、标题都会剔除 CSI/OSC/C0/C1 控制字符再渲染

## 已知限制

- 只支持文本 prompt；图片/附件、文件上传暂未接入
- 没有 trajectory 时间线、fork、subagent 浏览器、diff 预览
- 一个终端同一时间只跟一个 Session；其他 Session 仍在 Host 里继续跑
- 不列出 subagent Session；子代理发起的审批/提问不会路由到父 Session 的 TUI
- Host 重启后客户端会显示连接断开，需要重新启动 `dsh-attach`（不会自动重连）
- 未在 Windows 上测试；Unix socket 在 Windows 上会退化为命名管道，权限语义不同
- 通过 SSH 使用没问题：在远端机器上直接运行 `dsh-attach` 即可，不需要额外端口

## 故障排查

| 现象 | 处理 |
|---|---|
| `no attach endpoint under ...` | 插件没装/没挂载，或安装后没重启 App。检查 `~/.dsh/tui-attach/endpoint.json` |
| `cannot reach the attach bridge` | 描述文件指向旧进程；客户端会自动尝试同目录其他 endpoint。仍失败就重启 App |
| `unknown attach method` | 正在运行的 Host 还是旧版插件代码；重启 App |
| 审批/提问跑到了 Web | 0.4.0 起默认 `tui`；如果仍被 Web 抢先，检查配置是否还是 `auto`/`web`，并重启 App 加载新配置 |
| `Esc` 后问题一直 pending | 这是 Host 对 timed question 的语义：用 `s` 立即 skip，或等超时/在 Web 里回答 |
| 输入框不响应 | 先按 `Esc` 关闭残留面板；`Ctrl+C` 退出后重开 |

## 开发

```sh
cd dsh-tui-attach
pnpm install
pnpm test
```

测试覆盖：参数校验、list/open/prompt、实时 frame、审批/提问路由（含 Web 在线时的 `tui` 模式）、取消、Host 命令、自动补全、主题、ANSI 清理。

Host 侧代码在 `lib/host/`，客户端在 `lib/client/`：

| 文件 | 作用 |
|---|---|
| `lib/host.js` | Cordis 插件入口、Config schema |
| `lib/host/server.js` | Unix socket、JSONL 协议、follow 泵、审批/提问路由、descriptor |
| `lib/client/connection.js` | 客户端连接、endpoint 发现、request/response |
| `lib/client/app.js` | TUI 布局、事件投影、命令、状态栏、补全浮层 |
| `lib/client/editor.js` | 从 Editor 高度中剥离补全列表，交给上方浮层渲染 |
| `lib/client/transcript.js` | Transcript 行组件、文本清理 |
| `lib/client/panels.js` | 审批/提问/选择器/信息面板 |
| `lib/shared/protocol.js` | 双端共享的协议常量 |

License: MIT
