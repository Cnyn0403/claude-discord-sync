# claude-discord-sync

把本機所有 Claude Code session 同步到 Discord：每個 session 自動建立一個頻道，對話內容即時鏡像過去；用 `ccd` 啟動的 session 還可以直接在 Discord 上對話、按按鈕核准權限。

```
 Discord guild                       本機
 ┌──────────────────────┐   ┌────────────────────────────────────────────┐
 │ 📁 Claude Sessions    │   │ daemon.ts（唯一的 bot 連線）                │
 │   #proj-15ab  ◀───────┼───┤  ├ 監看 ~/.claude/sessions/*.json → 建頻道  │
 │   #web-ffe3           │   │  ├ tail transcript JSONL → 貼到頻道         │
 │ 📁 …(ended)           │   │  └ Unix socket ◀─┐                          │
 └──────────────────────┘   │                  │                          │
                            │ channel-server.ts（每個 ccd session 一個）   │
                            │  └ MCP channel：Discord 訊息 / 權限 ⇄ session │
                            └────────────────────────────────────────────┘
```

## 運作方式

| 功能 | 機制 |
|---|---|
| 偵測 session | Claude Code 會把每個執行中的 session 寫進 `~/.claude/sessions/<pid>.json`。daemon 每 1.5 秒掃描一次，並確認 PID 還活著 |
| 本地 → Discord | 持續讀取 `~/.claude/projects/<dir>/<session>.jsonl`，把使用者輸入、Claude 回覆、工具呼叫摘要貼到頻道 |
| Discord → 本地 | `ccd` 會載入 `channel-server.ts`（Claude Code 的 channels 功能），訊息以 `<channel source="discord-sync">` 的形式送進 session |
| 權限核准 | channel 的 permission relay：在頻道貼出附「允許 / 拒絕」按鈕的訊息並 @ 你，也可以回覆 `yes abcde` |
| 狀態 | Claude 工作中時頻道會顯示「正在輸入…」；session 結束後頻道移到「Claude Sessions (ended)」分類，用 `--resume` 回來時會移回原分類 |

## 安裝

需要 [Bun](https://bun.sh)。

```bash
cd ~/claude-discord-sync
bun install
bun src/doctor.ts          # 唯讀檢查：bot 登入、guild 權限、目前的 session
```

**Bot token**：依序讀取 `DISCORD_BOT_TOKEN` 環境變數、`~/.claude/channels/discord-sync/.env`、官方 discord 外掛的 `~/.claude/channels/discord/.env`。如果已經設定過官方外掛，就不用另外設定。

**Bot 權限**：需要 Manage Channels、Send Messages、Add Reactions、Attach Files，並在 Developer Portal 開啟 **Message Content Intent**。

### 啟動 daemon

```bash
bun src/daemon.ts                      # 前景執行

# 或註冊成 systemd 使用者服務，開機自動啟動
mkdir -p ~/.config/systemd/user
cp contrib/claude-discord-sync.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-discord-sync
journalctl --user -u claude-discord-sync -f   # 看 log
```

### 用可以雙向對話的模式開 Claude Code

```bash
ln -s ~/claude-discord-sync/bin/ccd ~/.local/bin/ccd
ccd                 # 等同 claude，可以加任何參數，例如 ccd --resume
```

啟動時 Claude Code 會跳出一次 development channel 的確認畫面（目前 channels 還在 research preview 階段，自製的 channel 都需要這個旗標）。

用一般 `claude` 啟動的 session 一樣會被同步，只是在 Discord 上是唯讀的。

## 設定（選用）

`~/.claude/channels/discord-sync/config.json`：

```json
{
  "guildId": "123456789012345678",
  "allowFrom": ["你的 Discord user ID"],
  "categoryName": "Claude Sessions",
  "archiveCategoryName": "Claude Sessions (ended)",
  "kinds": ["interactive"],
  "backlog": 15,
  "showToolCalls": true
}
```

- `guildId`：bot 只在一個 guild 時會自動偵測。
- `allowFrom`：預設沿用官方外掛 `access.json` 的 `allowFrom`。**只有這些人能對 session 下指令或核准權限**，其他人的訊息會被標上 🚫 並忽略。
- `archiveCategoryName`：設成 `""` 表示 session 結束後不移動頻道。
- `backlog`：daemon 啟動時遇到已經在跑的 session，最多補貼多少則歷史訊息。

狀態檔 `state.json`（session ↔ 頻道對應、讀取進度）也在同一個資料夾，daemon 重啟後會從上次的位置繼續，不會重複貼文。

## 已知限制

- transcript 的 JSONL 格式是 Claude Code 的內部格式，改版後可能需要調整 `src/render.ts`。
- `AskUserQuestion` 的選擇題會顯示在 Discord 上，但目前只能在本地終端機作答。
- `/clear` 會產生新的 session ID，所以會開一個新頻道，舊頻道會被歸檔。
- 安全性：在 allowlist 裡的人，等於能在這台機器上透過 Claude 執行指令。guild 請保持私人。
