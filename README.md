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
 │   🗂️ archive forum     │   │                   │                          │
 └───────────────────────┘   │ channel-server.ts (one per ccd session)      │
                             │  └ MCP channel: Discord ⇄ Claude Code         │
                             │ ask-hook.ts / stop-hook.sh (ccd hooks)       │
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
- **Forum archive.** Ended sessions become a forum post with the full conversation attached and a *Resume* button. Falls back to an archive category if the server can't create forums.
- **Cleanup.** Archived sessions are deleted after a configurable number of days.

## Requirements

- Linux (uses `/proc` and `TIOCSTI`)
- [Bun](https://bun.sh)
- [Claude Code](https://claude.com/claude-code) with channels support
- tmux, for `/new` and `/resume`
- A Discord bot in a **private** server (see [Security](#security))

## Setup

### 1. Create the bot

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and add a bot. Copy its token.
2. Under *Bot*, enable **Message Content Intent**.
3. Invite it with the `bot` and `applications.commands` scopes and these permissions: Manage Channels, Manage Threads, Send Messages, Add Reactions, Attach Files, Read Message History.

### 2. Install

```bash
git clone https://github.com/Cnyn0403/claude-discord-sync.git ~/claude-discord-sync
cd ~/claude-discord-sync
bun install

mkdir -p ~/.claude/channels/discord-sync
echo 'DISCORD_BOT_TOKEN=your-token' > ~/.claude/channels/discord-sync/.env
chmod 600 ~/.claude/channels/discord-sync/.env
```

Create `~/.claude/channels/discord-sync/config.json` with at least your Discord user ID (Settings → Advanced → Developer Mode, then right-click your name → *Copy User ID*):

```json
{ "allowFrom": ["your Discord user ID"] }
```

Check the setup (read-only):

```bash
bun src/doctor.ts
```

The token is read from `DISCORD_BOT_TOKEN`, then `~/.claude/channels/discord-sync/.env`, then the official Discord plugin's `~/.claude/channels/discord/.env`. If you already use the official plugin, its token and `allowFrom` are reused.

### 3. Run the daemon

```bash
bun src/daemon.ts            # foreground

# or as a systemd user service (edit the paths in the unit file if needed)
mkdir -p ~/.config/systemd/user
cp contrib/claude-discord-sync.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-discord-sync
journalctl --user -u claude-discord-sync -f
```

### 4. Start Claude Code with `ccd`

```bash
ln -s ~/claude-discord-sync/bin/ccd ~/.local/bin/ccd
ccd                 # same as `claude`; all arguments pass through, e.g. ccd --resume
```

`ccd` loads the discord-sync channel and its hooks. Claude Code asks you to confirm the development channel on startup, because custom channels are a research preview.

Sessions started with plain `claude` are still mirrored, but read-only on Discord.

## Commands

| Command | Where | What it does |
|---|---|---|
| `/new <dir> [prompt]` | anywhere | Start `ccd` in `<dir>` inside tmux. `dir` autocompletes subfolders and recently used folders |
| `/stop` | session channel | Interrupt the current turn (presses Esc) |
| `/end` | session channel | Interrupt if busy, then `/exit` |
| `/resume` | archive post or ended channel | `ccd --resume <id>` in tmux; a new channel is created |
| `/migrate` | anywhere | Move sessions archived as text channels into the forum |
| `yes abcde` / `no abcde` | session channel | Answer a permission prompt by its code |

Each command also works as `!new`, `!stop`, and so on.

## Configuration

`~/.claude/channels/discord-sync/config.json` (all optional except `allowFrom`):

```json
{
  "language": "en",
  "guildId": "123456789012345678",
  "allowFrom": ["your Discord user ID"],
  "categoryName": "Claude Sessions",
  "consoleChannelName": "claude-console",
  "archiveForumName": "claude-archive",
  "archiveCategoryName": "Claude Sessions (ended)",
  "deleteEndedAfterDays": 7,
  "kinds": ["interactive"],
  "backlog": 15,
  "showToolCalls": true,
  "notifyMinBusySec": 15,
  "attachOver": 3800
}
```

| Key | Meaning |
|---|---|
| `language` | `"en"` (default) or `"zh-TW"`. Slash command descriptions follow each user's Discord language regardless |
| `guildId` | Server to use. Auto-detected when the bot is in exactly one |
| `allowFrom` | Discord user IDs allowed to talk to sessions, press buttons and run commands. Everyone else gets 🚫 |
| `categoryName` | Category for session channels |
| `consoleChannelName` | Console channel name; `""` disables it. Defaults to `claude-console` (`claude-控制台` in zh-TW) |
| `archiveForumName` | Forum for ended sessions, default `claude-archive` (`claude-已結束` in zh-TW); `""` moves channels to `archiveCategoryName` instead. If the forum can't be created, archiving falls back to the category and retries the forum hourly |
| `archiveCategoryName` | Archive category when no forum is used; `""` leaves channels in place |
| `deleteEndedAfterDays` | Delete archived sessions after this many days; `0` keeps them |
| `kinds` | Session kinds to mirror, from `~/.claude/sessions/<pid>.json` |
| `backlog` | Past messages to post when a channel is created for an already-running session |
| `showToolCalls` | Post one-line tool call summaries |
| `notifyMinBusySec` | Minimum turn length (seconds) for a done notification; `-1` disables |
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
| Interrupt | tmux `send-keys Escape` when the session runs in tmux; otherwise the channel server types Esc into Claude Code's terminal with `TIOCSTI`. If neither works, `bin/stop-hook.sh` stops Claude before its next tool call |
| New / resume | `tmux new-session` running `ccd`; startup dialogs (development channel, folder trust) are accepted automatically, and the last screen is posted if startup fails |
| Deleted channels | A deleted live channel is recreated with a backlog. A deleted archive post or ended channel removes the session from the lists |

## Security

**Anyone in `allowFrom` can run commands on your machine through Claude.** Keep the server private and the allowlist short.

- Starting sessions from Discord accepts Claude Code's folder trust dialog for the folder you name.
- The bot token is stored in plain text in `~/.claude/channels/discord-sync/.env`. Keep it `chmod 600`.
- Files you upload on Discord are saved to `~/.claude/channels/discord-sync/inbox/`.

## Known limitations

- The transcript JSONL format is internal to Claude Code and may change; `src/render.ts` may need updates.
- While a `ccd` question or plan waits on Discord, no dialog appears in the terminal. Press *Answer in terminal* on Discord, or wait for the timeout.
- `TIOCSTI` is disabled by default on many Linux 6.2+ kernels (`dev.tty.legacy_tiocsti=0`). Then `/stop` only works for tmux sessions or through the stop hook, which can't stop a long-running command.
- `/clear` starts a new session ID, so it opens a new channel and archives the old one.

## License

[MIT](LICENSE)
