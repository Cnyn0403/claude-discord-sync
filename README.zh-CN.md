# claude-discord-sync

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文**

把本机每个 Claude Code session 同步到各自的 Discord 频道，并且能从 Discord 操作 session：和 Claude 对话、用下拉菜单回答它的问题、用按钮批准计划和权限、中断它，还能用手机新建 session、结束或恢复 session。

> 这是非官方的社区项目，和 Anthropic 没有关系。它用到了 Claude Code 的 *channels* 功能（research preview）和 Claude Code 内部的 session 文件，所以 Claude Code 更新后可能会失效。

Discord 上的文字支持英文、繁体中文和简体中文，用配置里的 `"language"` 切换，**默认是英文**，要用简体中文请设成 `"zh-CN"`。

```
 Discord guild                        本机
 ┌───────────────────────┐   ┌──────────────────────────────────────────────┐
 │ 📁 Claude Sessions     │   │ daemon.ts（唯一的 bot 连接）                  │
 │   #claude-控制台       │   │  ├ 监视 ~/.claude/sessions/*.json            │
 │   #proj-15ab  ◀────────┼───┤  ├ 读取 transcript JSONL → 发到频道          │
 │   #web-ffe3            │   │  └ Unix socket ◀──┐                          │
 │ 📁 Claude 已结束       │   │                   │                          │
 └───────────────────────┘   │ channel-server.ts（每个 ccd session 一个）    │
                             │  └ MCP channel：Discord ⇄ Claude Code         │
                             │ ask-hook.ts / stop-hook.ts（ccd 挂的 hook）   │
                             └──────────────────────────────────────────────┘
```

## 功能

- **每个 session 一个频道。** 每个运行中的 Claude Code session 都有自己的频道，Claude Code 为 session 生成标题后（或用 `/rename` 命名后），频道会改名为 `项目・标题`；你的输入、Claude 的回复和工具调用摘要都会实时同步。太长的回复只发预览，全文作为 `.md` 附件。
- **双向对话：** 用 `ccd`（`claude` 的包装命令）启动的 session，在频道里发的消息和附件都会转给 Claude。
- **选择题和计划变成按钮：** `AskUserQuestion` 会变成下拉菜单，可以选“其他”自己输入；`ExitPlanMode` 会变成“批准 / 继续修改 / 改在终端回答”按钮。
- **权限请求**会附带“允许 / 拒绝”按钮并 @ 你。
- **完成通知：** Claude 做完一段较长的工作时会 @ 你。
- **控制 session：** `/new`、`/stop`、`/end`、`/resume`（也可以用 `!new`、`!stop`…）。新建或恢复的 session 会在后台的 tmux 里运行，在本机可以用 `tmux attach` 接管。
- **控制台频道：** 列出所有 session 的状态，附带“中断 / 结束 / 恢复”菜单和新建 session 的按钮。
- **归档：** session 结束后保留原来的频道（包括会议子区），移到归档分类（`Claude 已结束`，每个分类放满 50 个后依次新建 `…-2`、`…-3`）。`/resume` 会把频道移回来。
- **自动清理：** 只有在服务器快到 Discord 500 个频道的上限时，才会删除最早结束的 session 频道（控制台会说明删了哪些）。对话记录和会议记录仍保留在你的电脑上。也可以另外设置保留天数。
- **多台电脑共用一个 bot：** 每台电脑各用一个服务器，见[多台电脑](#多台电脑共用一个-bot)。
- **新版本通知：** 有新版本时控制台会提醒你（见 `updateCheck`），是否更新由你决定。

## 要求

- Linux、macOS 或 Windows 10/11（见[平台支持](#平台支持)）
- 支持 channels 的 [Claude Code](https://claude.com/claude-code)，并用 claude.ai 账号或 Console API key 登录。Amazon Bedrock、Google Vertex AI、Microsoft Foundry 和第三方 API 网关都不能用 channels；Team 和 Enterprise 组织需要管理员先开启。没有 channels 时，`ccd` 的 session 会改用 hook 接收 Discord 消息（beta，见[不支持 channels 的登录方式](#不支持-channels-的登录方式beta)）
- 在 Linux 和 macOS 上，`/new`、`/resume` 需要 tmux（`brew install tmux`、`apt install tmux`）
- 一个在**私人**服务器里的 Discord bot（见[安全性](#安全性)），安装向导会一步步带你创建

## 平台支持

| | Linux | macOS | Windows |
|---|---|---|---|
| 同步、对话、选择题、计划、权限、控制台、归档 | ✅ | ✅ | ✅ |
| `/stop`、`/end`、`/model`、`/rename`、`/compact`（把按键发送到 session） | tmux 或 `TIOCSTI` | tmux 或通过系统自带 Perl 的 `TIOCSTI` | 把按键发送到 session 的控制台（**实验性**） |
| `/mode`、`/effort`（需要读取 session 的画面） | 仅限 tmux | 仅限 tmux | session 的控制台（**实验性**） |
| `/new`、`/resume` | tmux | tmux | 打开一个新的控制台窗口（**实验性**） |
| 开机自动启动 daemon（由 `setup` 设置） | systemd 用户服务 | launchd agent | 启动文件夹 |

Linux 是测试过的平台，macOS 和 Windows 是新加入的支持，遇到问题请[提 issue](https://github.com/Cnyn0403/claude-discord-sync/issues)。无论哪个平台，按键发不出去时，`/stop` 都会改为在 Claude 下一次调用工具前停止。

## 安装

**macOS／Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.sh | sh
```

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.ps1 | iex
```

安装程序会下载适用于你的平台的单个可执行文件（不需要 Bun 或 Node），用 release 的 SHA-256 校验文件，然后启动安装向导 `claude-discord-sync setup`，先选语言，然后：

1. 带你创建 bot，然后输入 token（输入时不会显示），并向 Discord 验证，包括有没有开启 **Message Content Intent**。
2. 显示邀请链接，等 bot 加入你的服务器。
3. 询问你的 Discord user ID（只有你能操作 session）。
4. 安装 `ccd` 命令。
5. 立即启动 daemon，并设置为每次登录时自动启动。

完成后打开一个新的终端，用 `ccd` 代替 `claude` 启动 Claude Code：

```bash
ccd                 # 所有参数都会透传，例如 ccd --resume
```

启动时 Claude Code 会要你确认 development channel，因为自制的 channel 目前还是 research preview。用普通 `claude` 启动的 session 一样会被同步，只是在 Discord 上是只读的。

| | |
|---|---|
| 检查配置（只读） | `claude-discord-sync doctor` |
| 修改配置 | 再运行一次 `claude-discord-sync setup`，或直接编辑 `~/.claude/channels/discord-sync/config.json` |
| 更新 | `claude-discord-sync update` 会下载最新版、校验后替换，并重启 daemon（加上 `--pre` 会包含预发布版） |
| 卸载 | `claude-discord-sync uninstall` 会移除程序、开机自启和 `ccd`，并询问要不要一并删除配置和 token |

可执行文件没有代码签名，所以 Windows SmartScreen 或 macOS Gatekeeper 可能会弹出警告；安装程序已经校验过下载文件的 checksum。

### 从源码安装

适合开发，或者没有预编译可执行文件的平台。需要 [Bun](https://bun.sh)。

```bash
git clone https://github.com/Cnyn0403/claude-discord-sync.git
cd claude-discord-sync
bun install
bun src/cli.ts setup        # 同样的安装向导；ccd 会指向这个文件夹里的 bin/ccd
```

也可以手动配置：把 [`.env.example`](.env.example) 复制到 `~/.claude/channels/discord-sync/.env` 并填入 token，参考 [`config.example.json`](config.example.json) 创建 `config.json`（至少要有 `allowFrom`），运行 `bun src/cli.ts daemon`，再用 `bin/ccd`（Windows 用 `bin\ccd.cmd`）启动 session。

token 会依次从 `DISCORD_BOT_TOKEN` 环境变量、`~/.claude/channels/discord-sync/.env`、官方 Discord 插件的 `~/.claude/channels/discord/.env` 读取。如果你已经在用官方插件，会直接沿用它的 token 和 `allowFrom`。

自己编译可执行文件：`bun build --compile --target=bun-<os>-<arch> src/cli.ts`。推送以 `v*` 开头的 tag，GitHub Actions 会自动编译所有平台并发布。

## 命令

| 命令 | 在哪里用 | 作用 |
|---|---|---|
| `/new <文件夹> [第一句话]` | 任意频道 | 在 tmux 里用 `ccd` 新建 session。文件夹参数会提示子文件夹和最近用过的文件夹 |
| `/stop` | session 频道 | 中断当前的工作（按 Esc） |
| `/end` | session 频道 | 如果正在工作就先中断，再 `/exit` |
| `/resume` | 已结束的频道 | 在 tmux 里运行 `ccd --resume <id>`，频道会从归档分类移回来 |
| `/usage` | 任意频道 | 只有你能看到。在 session 频道：模型、上下文用量、token 和运行时长；其他频道：所有进行中 session 的上下文用量。所有者还会看到套餐的本时段和本周用量 |
| `/handoff [补充]` | session 频道 | 生成交接文档（见[交接](#交接)） |
| `/rename <名称>` | session 频道 | 给 session 命名。频道本来就会按 Claude Code 自动生成的标题命名为 `项目・标题`；用这个命令（或 Claude Code 自己的 `/rename`）起的名字优先。session 空闲时，也会像 `/model` 一样输入到 Claude Code，让 `claude --resume` 显示同样的名称 |
| `/share @某人 <权限>` | session 频道 | 把这个 session 分享给某人（见[分享](#分享)） |
| `/unshare @某人` | session 频道 | 取消分享 |
| `/members` | session 频道 | 列出谁可以访问这个 session |
| `/sync off`／`/sync on` | session 频道，或在其他地方对所有 session | 暂停／恢复同步（见[暂停同步](#暂停同步)） |
| `/mode <模式>` | session 频道 | 切换权限模式（default、accept edits、plan、auto、bypass permissions），做法是不断按 Shift+Tab，直到 session 底部显示该模式。session 必须在 tmux 里（`/new` 开的都是）或者是 Windows 控制台窗口 |
| `/model <名称>` | session 频道 | 切换模型（`opus`、`sonnet`、`haiku`、`fable`、`default` 或模型 ID）。做法是在 session 里输入 `/model`，所以 Claude 必须处于空闲状态。和在本机输入一样，也会成为新 session 的默认模型 |
| `/effort <等级>` | session 频道 | 设置努力程度（`low`、`medium`、`high`、`xhigh`、`max`），只影响这个 session。做法是操作 Claude Code 的 `/effort` 菜单，所以 Claude 必须处于空闲状态，而且要能读取 session 的画面（同 `/mode`） |
| `/status` | session 频道 | 只有你能看到。显示 session 的模型、努力程度、权限模式、上下文、prompt 缓存命中率、文件夹和 Claude Code 版本。所有者看到的同时也是控制面板：可以用菜单切换模型、努力程度和权限模式，也有 `/compact` 和交接的按钮。Claude 工作时做的更改，会等它停下来再应用 |
| `yes abcde` / `no abcde` | session 频道 | 用代码回答权限请求 |

`!new`、`!stop`、`!end`、`!resume`、`!sync`、`!mode`、`!model`、`!effort`、`!rename`、`!handoff` 也可以直接作为普通消息发送，例如 `!sync off`。`/status`、`/usage`、`/share`、`/unshare`、`/members` 只能用斜杠命令。

## 分享

session 频道默认是私密的，只有 bot 和 `allowFrom` 里的所有者能看到。要让别人参与某个 session，在那个频道输入 `/share @某人 <权限>`：

| | 所有者 | 完整 | 协作 | 查看 |
|---|---|---|---|---|
| 看到频道和对话、`/members`、`/usage`、`/status` | ✅ | ✅ | ✅ | ✅ |
| 和 Claude 对话、回答选择题、`/stop`、`/rename`、`/handoff` | ✅ | ✅ | ✅ | |
| 批准权限请求和计划 | ✅ | ✅ | | |
| `/end`、`/new`、`/resume`、`/share`、`/unshare`、`/sync`、`/mode`、`/model`、`/effort`、`/status` 的控制项、控制台 | ✅ | | | |

协作者发给 Claude 的消息会标明他们的身份。能和 Claude 对话的人就能让它在你的电脑上做事，请只分享给你信任的人。分享设置在 `/resume` 之后和归档期间都仍然有效。

这个功能需要 bot 有“管理身份组”（Manage Roles）权限。没有的话 daemon 会在日志里提示，频道会保持全服务器可见，`/share` 也无法使用。

## 会议模式

想和分享了 session 的人讨论事情，又不想刷屏 session 频道、污染 Claude 的上下文时：

1. **开始：**在 session 频道 @ 某个人（不是 bot）。bot 会在那条消息上创建一个子区，并把被 @ 的人拉进去。session 频道照常运行。
2. **问 Claude：**在子区里 @ bot 并写上问题，会由一个只读的 session 分身回答。它了解到目前为止的对话，也能读文件（Read、Grep、Glob），但不能修改任何东西，问答也不会进入原来的 session。背后是每个问题都在后台启动一个一次性的 `claude -p --resume <session> --fork-session --no-session-persistence`，并把到目前为止的讨论交给它：它总能看到 session 的最新状态，不会在 `claude --resume` 列表里留下多余的 session，每个问题都会像普通请求一样计费。
3. **结束：**`@bot end`，后面可以接结论（“@bot end 就用方案 A”）。子区会被关闭，Claude 会收到整段讨论的 Markdown 文件（谁说了什么、各自的角色、分身的回答，附件会下载到本机），加上结论。没写结论的话，Claude 会整理讨论内容并提出下一步建议。`@bot save`（可以接结论）则是关闭子区、只保存记录，不交给 Claude。

**会议记录：**每条消息都会实时写入 `~/.claude/channels/discord-sync/meetings/<session-id>/<子区-id>.jsonl`（另外还有一份 `.md`，交给 Claude 的就是它），所以就算子区被删、或者会议没有正式结束，记录也都还在。会议结束时，session 频道会出现一条**“会议已记录”**并置顶，附带整理好的**独立 HTML 网页**：排版和 Discord 类似，有头像、名称、时间，Markdown（含代码块和表格）和图片都能正确显示，所有内容都打包在文件里，不联网也能用浏览器打开。所以频道的置顶消息就是这个 session 开过的所有会议。session 结束时还没结束的会议会保存并记录，但不会交给 Claude。置顶需要“标注消息”（Pin Messages）权限；没有的话照样会发出记录，只是不置顶。

只有能看到 session 频道的人才能加入（用 `/share` 分享）。会议 30 分钟没人说话时，bot 会提醒一次；它不会自己把会议交给 Claude。同时 @ 了人和 bot 的消息会作为普通消息交给 Claude，不会开会议。

## 不支持 channels 的登录方式（beta）

Claude Code 的 channels 需要用 claude.ai 账号或 Console API key 登录。如果用的是 Amazon Bedrock、Google Vertex AI、Microsoft Foundry 或 API 网关（`ANTHROPIC_BASE_URL`），`ccd` 的 session 会改用 hook 接收 Discord 的输入：

- **消息**：session 空闲时通过 `asyncRewake` hook 唤醒 Claude；Claude 工作时发送的消息，会在下一次工具调用后交给它。Claude Code 会把 hook 的输出标为系统通知而不是用户输入，所以 Claude 对这类消息可能会比 channel 消息谨慎一些。
- **权限请求**：通过 `PermissionRequest` hook 发出“允许／拒绝／改在终端回答”按钮，终端的对话框同时也能操作。
- 选择题、计划、`/stop`、`/new` 等其他功能和使用 channels 时相同。终端上这些消息只会显示为“Stop hook feedback”。

使用哪种方式是根据 Claude Code 的环境变量判断的（包括 `settings.json` 里的 `env`），也可以在配置文件里用 `"input"` 指定。这是新功能，测试得比 channels 少，有问题请[反馈](https://github.com/Cnyn0403/claude-discord-sync/issues)。

## 用量

`ccd` 启动的 session 会挂上一个小的状态栏程序（`claude-discord-sync statusline`），把 Claude Code 交给状态栏的数据保存下来：上下文窗口用量、套餐的本时段和本周限额、累计数字。如果你在 `~/.claude/settings.json` 里设置了自己的状态栏，它会用同样的输入照常运行，终端里看起来没有变化。普通 `claude` 启动的 session 只能从 transcript 得知上下文大小。

- **控制台：**顶部显示套餐用量（`📊 本时段 40% · 2 小时后重置 · 本周 15% · …`），每个进行中的 session 后面显示上下文用量（`🧠 35%`），以 5% 为单位。
- **实时状态消息：**在 Claude 正在做的事旁边显示上下文用量。
- **`/usage`：**详细数据，只有你能看到（见[命令](#命令)）。
- **上下文提醒：**session 的上下文超过 80% 时，频道会提醒一次，并附上“生成交接文档”按钮。上下文降到 50% 以下（`/compact`、`/clear` 之后）会重新启用提醒。

不显示费用：在订阅套餐下，等值的 API 费用并不是你实际支付的金额。

## 交接

`/handoff [补充]`（或 `!handoff`，或上下文提醒上的按钮）会像会议一样，由只读分身为这个 session 撰写交接文档，让看不到这段对话的新 session 能够接手：目标、已完成的事、当前状态、重要决定及原因、未解决的问题、下一步、关键文件、验证方式。daemon 会把 git 分支、未提交的修改和最近的 commit 一起交给它。不会打断原来的 session，Claude 正在工作时也能用。

交接文档会保存在 `~/.claude/channels/discord-sync/handoffs/<session-id>/`，并发到 session 频道置顶，附带两个按钮：

- **用这份交接文档新建 session：**在同一个文件夹启动 `ccd`，让它先读交接文档，再从“下一步”继续。新旧频道会互相附上链接。
- **结束这个 session：**等同于 `/end`。不会自动结束任何 session。

## 暂停同步

接下来要处理不该出现在 Discord 上的东西时，可以暂停同步：

- **在电脑上：**`claude-discord-sync pause`／`unpause`。在 Claude Code session 里运行（`! claude-discord-sync pause`）会暂停那个 session；在其他地方运行，或者加上 `all`，会暂停所有 session。
- **在 Discord 上：**在 session 频道输入 `/sync off`／`/sync on`，在其他地方输入则作用于所有 session；也可以用控制台的暂停功能。

暂停期间，这个 session 的内容都不会发到 Discord（连控制台上的标题都不会更新），选择题、计划和权限请求都在终端里回答，从 Discord 发的消息也不会转给 Claude。恢复时**不会**补发暂停期间的内容，只会显示有几条消息没有同步。

## 多台电脑共用一个 bot

同一个 bot 可以给多台电脑用，条件是**每台电脑使用各自的服务器**：把 bot 邀请到每台电脑各自的服务器，并在那台电脑的设置（`claude-discord-sync setup`）里选择它。每个 daemon 都会收到所有服务器的事件，但只处理自己的服务器，所以电脑之间不需要互相协调。

设置时会标出已经有其他电脑在使用的服务器。daemon 启动时也会再检查一次：控制台频道的主题里记录着由哪台电脑负责这个服务器，以及最后一次上报的时间（每几分钟更新一次）。如果发现 20 分钟内有其他电脑在使用，daemon 会在控制台说明原因并退出。

## 配置

`~/.claude/channels/discord-sync/config.json`（除了 `allowFrom` 都是可选的）：

```json
{
  "language": "zh-CN",
  "guildId": "123456789012345678",
  "allowFrom": ["你的 Discord user ID"],
  "categoryName": "Claude Sessions",
  "consoleChannelName": "claude-控制台",
  "archiveCategoryName": "Claude 已结束",
  "kinds": ["interactive"],
  "backlog": 15,
  "showToolCalls": true,
  "notifyMinBusySec": 15,
  "liveStatus": true,
  "attachOver": 3800
}
```

| 配置项 | 说明 |
|---|---|
| `language` | `"en"`（默认）、`"zh-TW"` 或 `"zh-CN"`。斜杠命令的说明不受这个配置影响，会按每个人自己的 Discord 语言显示 |
| `guildId` | 这台电脑使用的服务器，设置时会询问。每台电脑需要各自的服务器 |
| `allowFrom` | 所有者：对所有 session 有完整权限的 Discord user ID。其他人只拥有 session [分享](#分享)给他们的权限 |
| `categoryName` | session 频道所在的分类 |
| `consoleChannelName` | 控制台频道名称；设成 `""` 就不创建。默认是 `claude-控制台`（英文界面是 `claude-console`） |
| `archiveCategoryName` | 已结束 session 的分类，默认是 `Claude 已结束`（英文界面是 `Claude Sessions (ended)`，繁体中文界面是 `Claude 已結束`）；放满时会依次新建 `…-2`、`…-3`。设成 `""` 就让频道留在原处 |
| `deleteEndedAfterDays` | 另外在 session 结束几天后删除它的频道。不设置或设成 `0`：保留到服务器快满 500 个频道为止 |
| `kinds` | 要同步的 session 类型，对应 `~/.claude/sessions/<pid>.json` 里的 `kind` |
| `backlog` | 为已经在运行的 session 创建频道时，最多补发几条旧消息 |
| `showToolCalls` | 是否发出工具调用的一行摘要 |
| `notifyMinBusySec` | 工作至少几秒才发完成通知；设成 `-1` 就关闭 |
| `liveStatus` | Claude 工作时，在频道底部保留一条消息，显示已经工作了多久、正在用哪个工具；设成 `false` 就关闭 |
| `attachOver` | 回复超过多少个字符就改为附件 |
| `updateCheck` | 每天检查一次 GitHub 有没有新版本；有的话会在控制台 @ 你通知一次，并一直显示在最上面直到更新。`false` 关闭 |
| `input` | Discord 消息怎么发送到 `ccd` 的 session：`"auto"`（默认：Bedrock、Vertex、Foundry 和 API 网关用 hook，其他用 channels）、`"channels"` 或 `"hooks"`（见[不支持 channels 的登录方式](#不支持-channels-的登录方式beta)） |

环境变量 `DISCORD_SYNC_ASK_TIMEOUT`（秒，默认 600）决定选择题或计划在 Discord 上等多久，超时就回到终端作答。

同一个文件夹里的 `state.json` 记录了每个 session 对应哪个频道、对话记录读到了哪里，所以 daemon 重启后不会重复发消息。

## 工作原理

| 部分 | 机制 |
|---|---|
| 检测 session | Claude Code 会把每个运行中的 session 写入 `~/.claude/sessions/<pid>.json`。daemon 每 1.5 秒扫描一次，并确认 PID 还活着 |
| 本机 → Discord | 持续读取 `~/.claude/projects/<dir>/<session>.jsonl`，转成用户输入、回复和工具调用（`src/render.ts`） |
| Discord → 本机 | `ccd` 会把 `channel-server.ts` 作为 Claude Code 的 channel 加载，消息以 `<channel source="discord-sync">` 的形式送进 session |
| 权限 | channel 的 permission relay 会发出“允许 / 拒绝”按钮 |
| 选择题和计划 | `AskUserQuestion` 和 `ExitPlanMode` 的 `PreToolUse` hook（`src/ask-hook.ts`）会让 daemon 发出菜单或按钮，再通过 `updatedInput.answers` 交回答案，或者带着意见允许／拒绝 |
| 中断 | session 在 tmux 里就用 `tmux send-keys Escape`；否则由 channel server 通过 `TIOCSTI` 把 Esc 塞进 Claude Code 的终端。两者都不行时，`src/stop-hook.ts` 会在 Claude 下一次调用工具前让它停下 |
| 新建 / 恢复 | 用 `tmux new-session` 运行 `ccd`，自动接受启动时的确认界面（development channel、信任文件夹）；启动失败时会把最后的屏幕内容发回来 |
| 删除频道 | 运行中 session 的频道被删除时，会自动重建并补发最近的消息。已结束的频道被删除时，会把 session 从列表中移除 |

## 安全性

**`allowFrom` 里的人都能通过 Claude 在你的电脑上运行命令。** 请保持服务器私密，allowlist 越短越好。

- 从 Discord 新建 session 时，会自动接受 Claude Code 对该文件夹的信任确认。
- bot token 以明文保存在 `~/.claude/channels/discord-sync/.env`，请保持 `chmod 600`。
- 你在 Discord 上传的文件会保存到 `~/.claude/channels/discord-sync/inbox/`。

## 已知限制

- transcript 的 JSONL 格式是 Claude Code 的内部格式，可能会变，到时 `src/render.ts` 需要跟着调整。
- `ccd` 的选择题或计划在 Discord 等待回答期间，终端里不会出现对话框；要在本机回答，请在 Discord 点“改在终端回答”，或者等待超时。
- 很多 Linux 6.2 以后的内核默认关闭 `TIOCSTI`（`dev.tty.legacy_tiocsti=0`）。这时 `/stop` 只对 tmux 里的 session 有效，否则只能靠 stop hook，而它停不下正在运行的长命令。
- Windows 上的 `/new`、`/resume` 是靠读取新窗口的屏幕内容来点掉启动确认界面的，能不能成功取决于你的终端如何承载控制台。
- `/clear` 会生成新的 session ID，所以会开一个新频道，旧的会被归档。

## 许可证

[MIT](LICENSE)
