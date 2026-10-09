# claude-discord-sync

**English** · [繁體中文](README.zh-TW.md)

Mirror every Claude Code session on your machine into its own Discord channel, and drive sessions from Discord: chat with Claude, answer its questions with select menus, approve plans and permissions with buttons, interrupt it, and start, end or resume sessions from your phone.

> Unofficial community project, not affiliated with Anthropic. It relies on Claude Code's *channels* feature (research preview) and on Claude Code's internal session files, so a Claude Code update can break it.

The Discord-facing text is available in English and Traditional Chinese (`"language"` in the config).

```
 Discord guild                        this machine
 ┌───────────────────────┐   ┌──────────────────────────────────────────────┐
 │ 📁 Claude Sessions     │   │ daemon.ts (the only bot connection)          │
 │   #claude-console      │   │  ├ watches ~/.claude/sessions/*.json         │
 │   #proj-15ab  ◀────────┼───┤  ├ tails transcript JSONL → posts to channel │
 │   #web-ffe3            │   │  └ Unix socket ◀──┐                          │
 │ 📁 … (ended)           │   │                   │                          │
 └───────────────────────┘   │ channel-server.ts (one per ccd session)      │
                             │  └ MCP channel: Discord ⇄ Claude Code         │
                             │ ask-hook.ts / stop-hook.ts (ccd hooks)       │
                             └──────────────────────────────────────────────┘
```

## Features

- **One channel per session.** Every running Claude Code session gets a channel; your prompts, Claude's replies and one-line tool summaries are mirrored live. Long replies are posted as a preview plus a `.md` attachment.
- **Two-way chat** for sessions started with `ccd` (a wrapper around `claude`). Messages and attachments you post in the channel go to Claude.
- **Questions and plans as components.** `AskUserQuestion` becomes select menus (with a free-text "other" option); `ExitPlanMode` becomes *Approve / Revise / Answer in terminal* buttons.
- **Permission prompts** get *Allow / Deny* buttons and an @-mention.
- **Done notifications.** You're @-mentioned when Claude finishes a turn that took a while.
- **Session control:** `/new`, `/stop`, `/end`, `/resume` (or `!new`, `!stop`, …). New and resumed sessions run in a detached tmux session you can `tmux attach` to locally.
- **Console channel** listing every session with its status, plus menus to stop / end / resume and a button to start a new one.
- **Archive.** Ended sessions keep their channel, meeting threads included, and move to an archive category (`Claude Sessions (ended)`, then `…-2`, `…-3` as each fills its 50 channels). `/resume` moves a channel back.
- **Cleanup.** Only when the server nears Discord's 500-channel limit are the channels of the sessions that ended longest ago deleted (the console says which); their transcripts and meeting records stay on your computer. A time limit is optional.
- **Several computers, one bot.** Each computer uses its own server; see [Several computers](#several-computers-one-bot).

## Requirements

- Linux, macOS, or Windows 10/11 (see [Platform support](#platform-support))
- [Claude Code](https://claude.com/claude-code) with channels support
- tmux for `/new` and `/resume` on Linux and macOS (`brew install tmux`, `apt install tmux`)
- A Discord bot in a **private** server (see [Security](#security)); setup walks you through creating one

## Platform support

| | Linux | macOS | Windows |
|---|---|---|---|
| Mirroring, chat, questions, plans, permissions, console, archive | ✅ | ✅ | ✅ |
| `/stop`, `/end` | tmux, or `TIOCSTI` | tmux, or `TIOCSTI` via the system Perl | types into the session's console (**experimental**) |
| `/new`, `/resume` | tmux | tmux | opens a new console window (**experimental**) |
| Daemon at login (set up by `setup`) | systemd user unit | launchd agent | Startup folder |

Linux is the tested platform. macOS and Windows support is new; please [open an issue](https://github.com/Cnyn0403/claude-discord-sync/issues) if something doesn't work. On every platform, `/stop` falls back to stopping Claude before its next tool call when keys can't be typed.

## Install

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.ps1 | iex
```

The installer downloads a single executable for your platform (no Bun or Node needed), checks its SHA-256 against the release, and starts `claude-discord-sync setup`, which:

1. Walks you through creating the bot, then asks for its token (hidden while you type) and checks it with Discord, including **Message Content Intent**.
2. Prints an invite link and waits for the bot to join your server.
3. Asks for your Discord user ID (only you can control sessions) and the language.
4. Installs the `ccd` command.
5. Starts the daemon now and at every login.

Then open a new terminal and start Claude Code with `ccd` instead of `claude`:

```bash
ccd                 # all arguments pass through, e.g. ccd --resume
```

Claude Code asks you to confirm the development channel on startup, because custom channels are a research preview. Sessions started with plain `claude` are still mirrored, but read-only on Discord.

| | |
|---|---|
| Check the setup (read-only) | `claude-discord-sync doctor` |
| Change settings | run `claude-discord-sync setup` again, or edit `~/.claude/channels/discord-sync/config.json` |
| Update | `claude-discord-sync update` downloads the latest release, verifies it and restarts the daemon (`--pre` includes prereleases) |
| Uninstall | `claude-discord-sync uninstall` removes the program, autostart and `ccd`, and asks whether to delete your config and token too |

The executables are not code-signed. If Windows SmartScreen or macOS Gatekeeper complains, that's why; the installer verifies the checksum of what it downloaded.

### From source

For development, or a platform without a prebuilt executable. Needs [Bun](https://bun.sh).

```bash
git clone https://github.com/Cnyn0403/claude-discord-sync.git
cd claude-discord-sync
bun install
bun src/cli.ts setup        # same wizard; ccd then points at bin/ccd in this checkout
```

Or configure by hand: copy [`.env.example`](.env.example) to `~/.claude/channels/discord-sync/.env` and fill in the token, create `config.json` from [`config.example.json`](config.example.json) (at least `allowFrom`), run `bun src/cli.ts daemon`, and start sessions with `bin/ccd` (`bin\ccd.cmd` on Windows).

The token is read from `DISCORD_BOT_TOKEN`, then `~/.claude/channels/discord-sync/.env`, then the official Discord plugin's `~/.claude/channels/discord/.env`. If you already use the official plugin, its token and `allowFrom` are reused.

To build the executables yourself: `bun build --compile --target=bun-<os>-<arch> src/cli.ts`. Pushing a `v*` tag builds and publishes all of them with GitHub Actions.

## Commands

| Command | Where | What it does |
|---|---|---|
| `/new <dir> [prompt]` | anywhere | Start `ccd` in `<dir>` inside tmux. `dir` autocompletes subfolders and recently used folders |
| `/stop` | session channel | Interrupt the current turn (presses Esc) |
| `/end` | session channel | Interrupt if busy, then `/exit` |
| `/resume` | ended channel | `ccd --resume <id>` in tmux; the channel moves back from the archive |
| `/share @user <role>` | session channel | Give someone access to this session (see [Sharing](#sharing)) |
| `/unshare @user` | session channel | Remove their access |
| `/members` | session channel | List who can access this session |
| `/sync off` / `/sync on` | session channel, or anywhere for every session | Pause / resume mirroring (see [Pausing](#pausing)) |
| `/mode <mode>` | session channel | Switch the permission mode (default, accept edits, plan, auto, bypass permissions) by pressing Shift+Tab until the session's footer shows it. Needs a session in tmux (anything started with `/new`) or a Windows console window |
| `/model <name>` | session channel | Switch the model (`opus`, `sonnet`, `haiku`, `fable`, `default` or a model ID). Types `/model` into the session, so Claude must be idle. Like typing it locally, it also becomes your default for new sessions |
| `yes abcde` / `no abcde` | session channel | Answer a permission prompt by its code |

Each command also works as `!new`, `!stop`, `!sync off`, and so on.

## Sharing

Session channels are private: only the bot and the owners in `allowFrom` can see them. To bring someone into one session, use `/share @user <role>` in its channel:

| | Owner | Full | Collaborate | View |
|---|---|---|---|---|
| See the channel and conversation | ✅ | ✅ | ✅ | ✅ |
| Talk to Claude, answer questions, `/stop` | ✅ | ✅ | ✅ | |
| Approve permission prompts and plans | ✅ | ✅ | | |
| `/end`, `/share`, `/new`, `/resume`, the console | ✅ | | | |

Collaborators' messages reach Claude marked with their role. Anyone who can talk to Claude can make it act on your computer, so share with care. Access is kept across `/resume` and in the archive.

This needs the bot's **Manage Roles** permission. Without it the daemon logs a warning, channels stay visible to the whole server and `/share` is disabled.

## Meetings

To talk things over with the people you shared a session with, without cluttering the session channel or Claude's context:

1. **Start:** @-mention someone (not the bot) in the session channel. The bot opens a thread on that message and adds the people mentioned. The session channel carries on as usual.
2. **Ask Claude:** in the thread, @-mention the bot with a question. A read-only copy of the session answers: it knows the conversation so far and can read files (Read, Grep, Glob), but can't change anything, and the questions don't reach the session itself. Under the hood each question is a fresh, throwaway `claude -p --resume <session> --fork-session --no-session-persistence` that is given the discussion so far: it always sees the session as it is now, leaves no extra session behind in `claude --resume`, and costs a normal request.
3. **Finish:** `@bot end`, optionally followed by the conclusion ("@bot end let's go with option A"). The thread is closed and Claude receives the whole discussion as a Markdown file (who said what, with their role, the copy's answers, attachments saved locally) plus the conclusion. With no conclusion, Claude summarizes the discussion and proposes next steps. `@bot save` (optionally with a conclusion) closes the thread and only keeps the record; Claude isn't told.

**Records.** Every message is written to disk as it is said, in `~/.claude/channels/discord-sync/meetings/<session-id>/<thread-id>.jsonl` (plus a `.md` copy that is what Claude gets), so a meeting is kept even if the thread is deleted or never ended. When a meeting closes, the session channel gets a **"Meeting recorded"** message, pinned, with the meeting as **one self-contained HTML page**: laid out like Discord with avatars, names and times, Markdown (code blocks and tables included) and images inline, all embedded so it opens offline in any browser. The channel's pins thus list every meeting the session had. A meeting still open when the session ends is saved and recorded, not sent to Claude. Pinning needs the **Pin Messages** permission; without it the record is posted unpinned.

Only people who can see the session channel can join (use `/share`). The bot reminds you once if a meeting goes quiet for 30 minutes; it never sends a meeting to Claude on its own. A message mentioning both a person and the bot is a normal message to Claude, not a meeting.

## Pausing

Pause mirroring when you're about to work on something that shouldn't reach Discord:

- **On the computer:** `claude-discord-sync pause` / `unpause`. Inside a Claude Code session (`! claude-discord-sync pause`) it pauses that session; elsewhere, or with `all`, every session.
- **On Discord:** `/sync off` / `/sync on` in a session channel, anywhere else for every session, or the console's pause controls.

While paused, nothing from the session is posted (not even its title in the console), questions, plans and permission prompts are answered in the terminal, and messages sent on Discord are not passed to Claude. On resume, the paused stretch is **not** posted afterwards; the channel just says how many messages were skipped.

## Several computers, one bot

One bot can serve several computers, as long as **each computer uses its own server**: invite the bot to one server per computer and pick it in that computer's setup (`claude-discord-sync setup`). Every daemon receives every server's events and handles only its own, so nothing has to be coordinated between computers.

Setup marks servers another computer is already using. A daemon also checks at startup: the console channel's topic records which computer runs the server and when it last checked in (every few minutes), and a daemon that finds another computer active there in the last 20 minutes says so in the console and exits.

## Configuration

`~/.claude/channels/discord-sync/config.json` (all optional except `allowFrom`):

```json
{
  "language": "en",
  "guildId": "123456789012345678",
  "allowFrom": ["your Discord user ID"],
  "categoryName": "Claude Sessions",
  "consoleChannelName": "claude-console",
  "archiveCategoryName": "Claude Sessions (ended)",
  "kinds": ["interactive"],
  "backlog": 15,
  "showToolCalls": true,
  "notifyMinBusySec": 15,
  "liveStatus": true,
  "attachOver": 3800
}
```

| Key | Meaning |
|---|---|
| `language` | `"en"` (default) or `"zh-TW"`. Slash command descriptions follow each user's Discord language regardless |
| `guildId` | Server this computer uses; setup asks. Each computer needs its own |
| `allowFrom` | Owners: Discord user IDs with full control of every session. Others only get what a session is [shared](#sharing) with them |
| `categoryName` | Category for session channels |
| `consoleChannelName` | Console channel name; `""` disables it. Defaults to `claude-console` (`claude-控制台` in zh-TW) |
| `archiveCategoryName` | Category for ended sessions, default `Claude Sessions (ended)` (`Claude 已結束` in zh-TW); more are opened as `…-2`, `…-3` when it fills up. `""` leaves channels in place |
| `deleteEndedAfterDays` | Also delete ended sessions' channels this many days after they ended. Unset or `0`: keep them until the server nears 500 channels |
| `kinds` | Session kinds to mirror, from `~/.claude/sessions/<pid>.json` |
| `backlog` | Past messages to post when a channel is created for an already-running session |
| `showToolCalls` | Post one-line tool call summaries |
| `notifyMinBusySec` | Minimum turn length (seconds) for a done notification; `-1` disables |
| `liveStatus` | While Claude works, keep one message at the bottom of the channel showing how long it has been working and which tool is running; `false` disables |
| `attachOver` | Replies longer than this many characters are attached as `.md` |

Environment variable `DISCORD_SYNC_ASK_TIMEOUT` (seconds, default 600) sets how long a question or plan waits on Discord before falling back to the terminal.

`state.json` in the same folder records which channel belongs to which session and how far each transcript has been read, so restarts don't repost anything.

## How it works

| Piece | Mechanism |
|---|---|
| Finding sessions | Claude Code registers each running session in `~/.claude/sessions/<pid>.json`. The daemon scans it every 1.5 s and checks that the PID is alive |
| Local → Discord | Tails `~/.claude/projects/<dir>/<session>.jsonl` and renders user prompts, replies and tool calls (`src/render.ts`) |
| Discord → local | `ccd` loads `channel-server.ts` as a Claude Code channel; messages arrive as `<channel source="discord-sync">` |
| Permissions | The channel's permission relay posts *Allow / Deny* buttons |
| Questions and plans | A `PreToolUse` hook (`src/ask-hook.ts`) on `AskUserQuestion` and `ExitPlanMode` asks the daemon, which posts components and returns the answer through `updatedInput.answers`, or allow / deny with feedback |
| Interrupt | tmux `send-keys Escape` when the session runs in tmux; otherwise the channel server types Esc into Claude Code's terminal with `TIOCSTI`. If neither works, `src/stop-hook.ts` stops Claude before its next tool call |
| New / resume | `tmux new-session` running `ccd`; startup dialogs (development channel, folder trust) are accepted automatically, and the last screen is posted if startup fails |
| Deleted channels | A deleted live channel is recreated with a backlog. A deleted ended channel removes the session from the lists |

## Security

**Anyone in `allowFrom` can run commands on your machine through Claude.** Keep the server private and the allowlist short.

- Starting sessions from Discord accepts Claude Code's folder trust dialog for the folder you name.
- The bot token is stored in plain text in `~/.claude/channels/discord-sync/.env`. Keep it `chmod 600`.
- Files you upload on Discord are saved to `~/.claude/channels/discord-sync/inbox/`.

## Known limitations

- The transcript JSONL format is internal to Claude Code and may change; `src/render.ts` may need updates.
- While a `ccd` question or plan waits on Discord, no dialog appears in the terminal. Press *Answer in terminal* on Discord, or wait for the timeout.
- `TIOCSTI` is disabled by default on many Linux 6.2+ kernels (`dev.tty.legacy_tiocsti=0`). Then `/stop` only works for tmux sessions or through the stop hook, which can't stop a long-running command.
- On Windows, `/new` and `/resume` accept the startup dialogs by reading the new window's screen, which depends on how your terminal hosts the console.
- `/clear` starts a new session ID, so it opens a new channel and archives the old one.

## License

[MIT](LICENSE)
