# claude-discord-sync

[English](README.md) · **繁體中文**

把本機每個 Claude Code session 同步到各自的 Discord 頻道，並且能從 Discord 操作 session：跟 Claude 對話、用下拉選單回答它的問題、用按鈕核准計畫和權限、中斷它，也能用手機開新 session、結束或恢復 session。

> 這是非官方的社群專案，跟 Anthropic 沒有關係。它用到 Claude Code 的 *channels* 功能（research preview）和 Claude Code 內部的 session 檔案，所以 Claude Code 更新後可能會壞掉。

Discord 上的文字支援英文和繁體中文，用設定裡的 `"language"` 切換，**預設是英文**，要用中文請設成 `"zh-TW"`。

```
 Discord guild                        本機
 ┌───────────────────────┐   ┌──────────────────────────────────────────────┐
 │ 📁 Claude Sessions     │   │ daemon.ts（唯一的 bot 連線）                  │
 │   #claude-控制台       │   │  ├ 監看 ~/.claude/sessions/*.json            │
 │   #proj-15ab  ◀────────┼───┤  ├ 讀取 transcript JSONL → 貼到頻道          │
 │   #web-ffe3            │   │  └ Unix socket ◀──┐                          │
 │   🗂️ 封存論壇          │   │                   │                          │
 └───────────────────────┘   │ channel-server.ts（每個 ccd session 一個）    │
                             │  └ MCP channel：Discord ⇄ Claude Code         │
                             │ ask-hook.ts / stop-hook.sh（ccd 掛的 hook）   │
                             └──────────────────────────────────────────────┘
```

## 功能

- **每個 session 一個頻道。** 每個執行中的 Claude Code session 都有自己的頻道，你的輸入、Claude 的回覆和工具呼叫摘要都會即時同步。太長的回覆只貼預覽，全文附成 `.md` 檔。
- **雙向對話：** 用 `ccd`（`claude` 的包裝指令）啟動的 session，在頻道裡傳的訊息和附件都會送給 Claude。
- **選擇題和計畫變成按鈕：** `AskUserQuestion` 會變成下拉選單，可以選「其他」自己輸入；`ExitPlanMode` 會變成「核准 / 繼續修改 / 改在終端機回答」按鈕。
- **權限請求**會附「允許 / 拒絕」按鈕並 @ 你。
- **完成通知：** Claude 做完一段較久的工作時會 @ 你。
- **控制 session：** `/new`、`/stop`、`/end`、`/resume`（也可以用 `!new`、`!stop`…）。開新的或恢復的 session 會在背景的 tmux 裡執行，本機可以用 `tmux attach` 接手。
- **控制台頻道：** 列出所有 session 的狀態，附「中斷 / 結束 / 恢復」選單和開新 session 的按鈕。
- **論壇封存：** session 結束後會變成一篇論壇貼文，附完整對話和「恢復」按鈕。伺服器不能建立論壇時，會改用封存分類。
- **自動清理：** 封存超過設定天數的 session 會被刪除。

## 需求

- Linux（用到 `/proc` 和 `TIOCSTI`）
- [Bun](https://bun.sh)
- 支援 channels 的 [Claude Code](https://claude.com/claude-code)
- tmux（`/new` 和 `/resume` 需要）
- 一個在**私人**伺服器裡的 Discord bot（見[安全性](#安全性)）

## 安裝

### 1. 建立 bot

到 [Discord Developer Portal](https://discord.com/developers/applications)：

1. 建立一個 application 並加入 bot，複製它的 token。
2. 在 *Bot* 頁面開啟 **Message Content Intent**。
3. 邀請 bot 時勾選 `bot` 和 `applications.commands` 兩個 scope，以及這些權限：Manage Channels、Manage Threads、Send Messages、Add Reactions、Attach Files、Read Message History。

### 2. 安裝

```bash
git clone https://github.com/Cnyn0403/claude-discord-sync.git ~/claude-discord-sync
cd ~/claude-discord-sync
bun install

mkdir -p ~/.claude/channels/discord-sync
echo 'DISCORD_BOT_TOKEN=你的 token' > ~/.claude/channels/discord-sync/.env
chmod 600 ~/.claude/channels/discord-sync/.env
```

建立 `~/.claude/channels/discord-sync/config.json`，至少要填你的 Discord user ID。取得方式：設定 → 進階 → 開啟開發者模式，然後在自己的名字上按右鍵 →「複製使用者 ID」。

```json
{ "language": "zh-TW", "allowFrom": ["你的 Discord user ID"] }
```

檢查設定（唯讀，不會改任何東西）：

```bash
bun src/doctor.ts
```

token 會依序從 `DISCORD_BOT_TOKEN` 環境變數、`~/.claude/channels/discord-sync/.env`、官方 Discord 外掛的 `~/.claude/channels/discord/.env` 讀取。如果你已經在用官方外掛，會直接沿用它的 token 和 `allowFrom`。

### 3. 啟動 daemon

```bash
bun src/daemon.ts            # 前景執行

# 或註冊成 systemd 使用者服務（路徑不同的話，請修改 unit 檔裡的路徑）
mkdir -p ~/.config/systemd/user
cp contrib/claude-discord-sync.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-discord-sync
journalctl --user -u claude-discord-sync -f
```

### 4. 用 `ccd` 啟動 Claude Code

```bash
ln -s ~/claude-discord-sync/bin/ccd ~/.local/bin/ccd
ccd                 # 等同 claude，所有參數都會傳過去，例如 ccd --resume
```

`ccd` 會載入 discord-sync 的 channel 和 hook。啟動時 Claude Code 會要你確認 development channel，因為自製的 channel 目前還是 research preview。

用一般 `claude` 啟動的 session 一樣會被同步，只是在 Discord 上是唯讀的。

## 指令

| 指令 | 在哪裡用 | 作用 |
|---|---|---|
| `/new <資料夾> [第一句話]` | 任何頻道 | 在 tmux 裡用 `ccd` 開新 session。資料夾欄位會提示子資料夾和最近用過的資料夾 |
| `/stop` | session 頻道 | 中斷目前的工作（按 Esc） |
| `/end` | session 頻道 | 工作中的話先中斷，再 `/exit` |
| `/resume` | 封存貼文或已結束的頻道 | 在 tmux 裡執行 `ccd --resume <id>`，並建立新頻道 |
| `/migrate` | 任何頻道 | 把用分類封存的舊頻道搬到論壇 |
| `yes abcde` / `no abcde` | session 頻道 | 用代碼回答權限請求 |

每個指令都可以改用 `!new`、`!stop` 這種寫法。

## 設定

`~/.claude/channels/discord-sync/config.json`（除了 `allowFrom` 都是選填）：

```json
{
  "language": "zh-TW",
  "guildId": "123456789012345678",
  "allowFrom": ["你的 Discord user ID"],
  "categoryName": "Claude Sessions",
  "consoleChannelName": "claude-控制台",
  "archiveForumName": "claude-已結束",
  "archiveCategoryName": "Claude Sessions (ended)",
  "deleteEndedAfterDays": 7,
  "kinds": ["interactive"],
  "backlog": 15,
  "showToolCalls": true,
  "notifyMinBusySec": 15,
  "attachOver": 3800
}
```

| 設定 | 說明 |
|---|---|
| `language` | `"en"`（預設）或 `"zh-TW"`。斜線指令的說明不受這個設定影響，會依照每個人自己的 Discord 語言顯示 |
| `guildId` | 要用的伺服器。bot 只在一個伺服器時會自動偵測 |
| `allowFrom` | 可以對 session 說話、按按鈕、下指令的 Discord user ID，其他人會被標上 🚫 |
| `categoryName` | session 頻道所在的分類 |
| `consoleChannelName` | 控制台頻道名稱；設成 `""` 就不建立。預設是 `claude-控制台`（英文介面是 `claude-console`） |
| `archiveForumName` | 封存用的論壇，預設是 `claude-已結束`（英文介面是 `claude-archive`）；設成 `""` 就改成把頻道移到 `archiveCategoryName`。論壇建立失敗時會自動改用分類，並每小時重試一次論壇 |
| `archiveCategoryName` | 沒用論壇時的封存分類；設成 `""` 就讓頻道留在原地 |
| `deleteEndedAfterDays` | 封存幾天後刪除；設成 `0` 就永遠保留 |
| `kinds` | 要同步的 session 類型，對應 `~/.claude/sessions/<pid>.json` 裡的 `kind` |
| `backlog` | 為已經在跑的 session 建頻道時，最多補貼幾則舊訊息 |
| `showToolCalls` | 是否貼出工具呼叫的一行摘要 |
| `notifyMinBusySec` | 工作至少幾秒才發完成通知；設成 `-1` 就關閉 |
| `attachOver` | 回覆超過幾個字就改成附檔 |

環境變數 `DISCORD_SYNC_ASK_TIMEOUT`（秒，預設 600）決定選擇題或計畫在 Discord 上等多久，逾時就回到終端機作答。

同一個資料夾裡的 `state.json` 記錄每個 session 對應哪個頻道、對話紀錄讀到哪裡，所以 daemon 重啟後不會重複貼文。

## 運作方式

| 部分 | 機制 |
|---|---|
| 偵測 session | Claude Code 會把每個執行中的 session 寫進 `~/.claude/sessions/<pid>.json`。daemon 每 1.5 秒掃描一次，並確認 PID 還活著 |
| 本機 → Discord | 持續讀取 `~/.claude/projects/<dir>/<session>.jsonl`，轉成使用者輸入、回覆和工具呼叫（`src/render.ts`） |
| Discord → 本機 | `ccd` 會把 `channel-server.ts` 當成 Claude Code 的 channel 載入，訊息以 `<channel source="discord-sync">` 的形式送進 session |
| 權限 | channel 的 permission relay 會貼出「允許 / 拒絕」按鈕 |
| 選擇題和計畫 | `AskUserQuestion` 和 `ExitPlanMode` 的 `PreToolUse` hook（`src/ask-hook.ts`）會請 daemon 貼出選單或按鈕，再透過 `updatedInput.answers` 交回答案，或是帶著意見允許／拒絕 |
| 中斷 | session 在 tmux 裡就用 `tmux send-keys Escape`；否則由 channel server 透過 `TIOCSTI` 把 Esc 塞進 Claude Code 的終端機。兩者都不行時，`bin/stop-hook.sh` 會在 Claude 下一次使用工具前停下它 |
| 開新 / 恢復 | 用 `tmux new-session` 執行 `ccd`，自動接受啟動時的確認畫面（development channel、信任資料夾）；啟動失敗時會把最後的畫面貼回來 |
| 刪除頻道 | 執行中 session 的頻道被刪掉時，會自動重建並補貼最近的訊息。封存貼文或已結束的頻道被刪掉時，會把 session 從清單移除 |

## 安全性

**`allowFrom` 裡的人都能透過 Claude 在你的電腦上執行指令。** 請讓伺服器保持私人，allowlist 越短越好。

- 從 Discord 開 session 時，會自動接受 Claude Code 對該資料夾的信任確認。
- bot token 以明文存在 `~/.claude/channels/discord-sync/.env`，請保持 `chmod 600`。
- 你在 Discord 上傳的檔案會存到 `~/.claude/channels/discord-sync/inbox/`。

## 已知限制

- transcript 的 JSONL 格式是 Claude Code 的內部格式，可能會變動，到時候 `src/render.ts` 需要跟著調整。
- `ccd` 的選擇題或計畫在 Discord 等待回答時，終端機不會出現對話框。要在本機回答，請在 Discord 按「改在終端機回答」，或等待逾時。
- 很多 Linux 6.2 以後的核心預設關閉 `TIOCSTI`（`dev.tty.legacy_tiocsti=0`）。這時 `/stop` 只對 tmux 裡的 session 有效，否則只能靠 stop hook，而它停不下正在跑的長指令。
- `/clear` 會產生新的 session ID，所以會開一個新頻道，舊的會被封存。

## 授權

[MIT](LICENSE)
