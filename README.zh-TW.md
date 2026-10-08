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
                             │ ask-hook.ts / stop-hook.ts（ccd 掛的 hook）   │
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

- Linux、macOS 或 Windows 10/11（見[平台支援](#平台支援)）
- 支援 channels 的 [Claude Code](https://claude.com/claude-code)
- Linux 和 macOS 上的 `/new`、`/resume` 需要 tmux（`brew install tmux`、`apt install tmux`）
- 一個在**私人**伺服器裡的 Discord bot（見[安全性](#安全性)），安裝精靈會一步一步帶你建立

## 平台支援

| | Linux | macOS | Windows |
|---|---|---|---|
| 同步、對話、選擇題、計畫、權限、控制台、封存 | ✅ | ✅ | ✅ |
| `/stop`、`/end` | tmux 或 `TIOCSTI` | tmux 或透過系統內建 Perl 的 `TIOCSTI` | 把按鍵送進 session 的主控台（**實驗性**） |
| `/new`、`/resume` | tmux | tmux | 開一個新的主控台視窗（**實驗性**） |
| 開機自動啟動 daemon（由 `setup` 設定） | systemd 使用者服務 | launchd agent | 啟動資料夾 |

Linux 是測試過的平台，macOS 和 Windows 是新加入的支援，遇到問題請[開 issue](https://github.com/Cnyn0403/claude-discord-sync/issues)。不論哪個平台，按鍵送不出去時，`/stop` 都會改成在 Claude 下一次使用工具前停止。

## 安裝

**macOS／Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.sh | sh
```

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/Cnyn0403/claude-discord-sync/master/install.ps1 | iex
```

安裝程式會下載你的平台專用的單一執行檔（不需要 Bun 或 Node），用 release 的 SHA-256 驗證檔案，再啟動安裝精靈 `claude-discord-sync setup`：

1. 帶你建立 bot，然後輸入 token（輸入時不會顯示），並向 Discord 驗證，包括有沒有開啟 **Message Content Intent**。
2. 顯示邀請連結，等 bot 加入你的伺服器。
3. 詢問你的 Discord user ID（只有你能操作 session）和介面語言。
4. 安裝 `ccd` 指令。
5. 立刻啟動 daemon，並設定每次登入時自動啟動。

完成後開一個新的終端機，用 `ccd` 取代 `claude` 啟動 Claude Code：

```bash
ccd                 # 所有參數都會傳過去，例如 ccd --resume
```

啟動時 Claude Code 會要你確認 development channel，因為自製的 channel 目前還是 research preview。用一般 `claude` 啟動的 session 一樣會被同步，只是在 Discord 上是唯讀的。

| | |
|---|---|
| 檢查設定（唯讀） | `claude-discord-sync doctor` |
| 修改設定 | 再執行一次 `claude-discord-sync setup`，或直接編輯 `~/.claude/channels/discord-sync/config.json` |
| 更新 | `claude-discord-sync update` 會下載最新版、驗證後替換，並重新啟動 daemon（加上 `--pre` 會包含測試版） |
| 解除安裝 | `claude-discord-sync uninstall` 會移除程式、自動啟動和 `ccd`，並詢問要不要一併刪除設定和 token |

執行檔沒有程式碼簽章，所以 Windows SmartScreen 或 macOS Gatekeeper 可能會跳出警告；安裝程式已經驗證過下載檔案的 checksum。

### 從原始碼安裝

適合開發，或是沒有預先編譯好執行檔的平台。需要 [Bun](https://bun.sh)。

```bash
git clone https://github.com/Cnyn0403/claude-discord-sync.git
cd claude-discord-sync
bun install
bun src/cli.ts setup        # 一樣的安裝精靈；ccd 會指向這個資料夾裡的 bin/ccd
```

也可以手動設定：把 [`.env.example`](.env.example) 複製到 `~/.claude/channels/discord-sync/.env` 並填入 token，參考 [`config.example.json`](config.example.json) 建立 `config.json`（至少要有 `allowFrom`），執行 `bun src/cli.ts daemon`，再用 `bin/ccd`（Windows 用 `bin\ccd.cmd`）啟動 session。

token 會依序從 `DISCORD_BOT_TOKEN` 環境變數、`~/.claude/channels/discord-sync/.env`、官方 Discord 外掛的 `~/.claude/channels/discord/.env` 讀取。如果你已經在用官方外掛，會直接沿用它的 token 和 `allowFrom`。

自己編譯執行檔：`bun build --compile --target=bun-<os>-<arch> src/cli.ts`。推送 `v*` 開頭的 tag，GitHub Actions 會自動編譯所有平台並發布。

## 指令

| 指令 | 在哪裡用 | 作用 |
|---|---|---|
| `/new <資料夾> [第一句話]` | 任何頻道 | 在 tmux 裡用 `ccd` 開新 session。資料夾欄位會提示子資料夾和最近用過的資料夾 |
| `/stop` | session 頻道 | 中斷目前的工作（按 Esc） |
| `/end` | session 頻道 | 工作中的話先中斷，再 `/exit` |
| `/resume` | 封存貼文或已結束的頻道 | 在 tmux 裡執行 `ccd --resume <id>`，並建立新頻道 |
| `/migrate` | 任何頻道 | 把用分類封存的舊頻道搬到論壇 |
| `/share @某人 <權限>` | session 頻道 | 把這個 session 分享給某人（見[分享](#分享)） |
| `/unshare @某人` | session 頻道 | 取消分享 |
| `/members` | session 頻道 | 列出誰可以存取這個 session |
| `/sync off`／`/sync on` | session 頻道，或在其他地方對所有 session | 暫停／恢復同步（見[暫停同步](#暫停同步)） |
| `/mode <模式>` | session 頻道 | 切換權限模式（default、accept edits、plan、auto、bypass permissions），做法是一直按 Shift+Tab，直到 session 底部顯示該模式。session 必須在 tmux 裡（`/new` 開的都是）或是 Windows 主控台視窗 |
| `/model <名稱>` | session 頻道 | 切換模型（`opus`、`sonnet`、`haiku`、`fable`、`default` 或模型 ID）。做法是在 session 裡輸入 `/model`，所以 Claude 必須是閒置狀態。跟在本機輸入一樣，也會變成新 session 的預設模型 |
| `yes abcde` / `no abcde` | session 頻道 | 用代碼回答權限請求 |

每個指令都可以改用 `!new`、`!stop`、`!sync off` 這種寫法。

## 分享

session 頻道預設是私人的，只有 bot 和 `allowFrom` 裡的擁有者看得到。要讓別人參與某個 session，在那個頻道輸入 `/share @某人 <權限>`：

| | 擁有者 | 完整 | 協作 | 觀看 |
|---|---|---|---|---|
| 看到頻道和對話 | ✅ | ✅ | ✅ | ✅ |
| 對 Claude 說話、回答選擇題、`/stop` | ✅ | ✅ | ✅ | |
| 核准權限請求和計畫 | ✅ | ✅ | | |
| `/end`、`/share`、`/new`、`/resume`、控制台 | ✅ | | | |

協作者傳給 Claude 的訊息會標註他們的身分。能對 Claude 說話的人就能叫它在你的電腦上做事，請只分享給你信任的人。分享設定在 `/resume` 之後仍然有效；封存到論壇的貼文只有擁有者看得到。

這個功能需要 bot 有「管理身分組」（Manage Roles）權限。沒有的話 daemon 會在 log 提示，頻道會維持全伺服器都看得到，`/share` 也無法使用。

## 會議模式

想跟分享進來的人討論，但不想每句話都傳給 Claude 時：

1. **開始：**在 session 頻道裡 tag 某個人（不是 bot），bot 會宣布進入會議模式，之後的訊息都只在你們之間。
2. **結束：**tag bot。這則訊息的其他內容就是結論，例如「@bot 決定用 A 方案，順便記錄到 docs/decisions.md」。如果只 tag 沒寫內容，Claude 會自己讀完討論、整理重點並提出下一步。

Claude 會收到整段討論的 Markdown 檔（誰說了什麼、身分是什麼）和結論。一則訊息同時 tag 了人和 bot，會當成一般訊息傳給 Claude，不會開始會議。會議期間一樣可以用 `yes abcde` 回答權限請求；會議如果 30 分鐘沒人說話，bot 會提醒一次，但不會自己把會議內容送給 Claude。

## 暫停同步

接下來要處理不該出現在 Discord 上的東西時，可以暫停同步：

- **在電腦上：**`claude-discord-sync pause`／`unpause`。在 Claude Code session 裡執行（`! claude-discord-sync pause`）會暫停那個 session；在其他地方執行，或加上 `all`，會暫停所有 session。
- **在 Discord 上：**在 session 頻道輸入 `/sync off`／`/sync on`，在其他地方輸入則是對所有 session；也可以用控制台的暫停功能。

暫停期間，這個 session 的內容都不會貼到 Discord（連控制台上的標題都不會更新），選擇題、計畫和權限請求都在終端機回答，從 Discord 傳的訊息也不會送給 Claude。恢復時**不會**補貼暫停期間的內容，只會顯示有幾則訊息沒有同步。

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
| `allowFrom` | 擁有者：對所有 session 有完整權限的 Discord user ID。其他人只能使用 session [分享](#分享)給他們的權限 |
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
| 中斷 | session 在 tmux 裡就用 `tmux send-keys Escape`；否則由 channel server 透過 `TIOCSTI` 把 Esc 塞進 Claude Code 的終端機。兩者都不行時，`src/stop-hook.ts` 會在 Claude 下一次使用工具前停下它 |
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
- Windows 上的 `/new`、`/resume` 是靠讀取新視窗的畫面來按掉啟動確認畫面，能不能成功取決於你的終端機怎麼承載主控台。
- `/clear` 會產生新的 session ID，所以會開一個新頻道，舊的會被封存。

## 授權

[MIT](LICENSE)
