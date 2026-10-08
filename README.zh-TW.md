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
| 計畫確認 | 同一個 hook 也會攔截 `ExitPlanMode`：頻道貼出計畫和「核准 / 繼續修改 / 改在終端機回答」按鈕，「繼續修改」會跳出文字框，內容會當成修改意見交回 Claude。計畫太長時訊息只放預覽，完整內容附成 `plan.md` |
| 完成通知 | Claude 工作超過 `notifyMinBusySec` 秒後回到閒置時，貼一則「✅ Claude 完成了」並 @ 你 |
| 長回覆 | 超過 `attachOver` 字的回覆只貼預覽，全文附成 `reply.md` |
| 開新 session | 在 guild 任一頻道輸入 `!new <資料夾> [第一句話]`，daemon 會在背景 tmux 裡執行 `ccd`，並自動接受開發者 channel、信任資料夾這兩個啟動確認畫面（會把游標移到「Yes」再按 Enter）。如果啟動失敗，會把 tmux 最後的畫面貼回頻道。頻道建立後會回覆連結，本機可以用 `tmux attach -t ccd-xxxx` 接手 |
| 中斷 | 在 session 頻道輸入 `!stop`：session 在 tmux 裡就用 `tmux send-keys Escape`；否則由 channel server 透過 `TIOCSTI` 把 Esc 塞進 Claude 的終端機。如果送不出 Esc，或 4 秒後 Claude 還在工作，就改用 `bin/stop-hook.sh` 這個 PreToolUse hook，在 Claude 下一次使用工具前停止 |
| 結束 / 恢復 | 在 session 頻道輸入 `!end`：Claude 在工作的話先中斷，再輸入 `/exit`（方式跟 `!stop` 一樣，tmux 或 `TIOCSTI`）。在已結束的頻道輸入 `!resume`，會在 tmux 裡執行 `ccd --resume <session ID>`，頻道移回原分類後繼續同步 |
| 選擇題 | `ccd` 會掛一個 `AskUserQuestion` 的 PreToolUse hook（`src/ask-hook.ts`）：daemon 在頻道貼出下拉選單並 @ 你，選完後答案經由 `updatedInput.answers` 交回 Claude。選單裡有「其他（自己輸入）」可以開文字框；按「改在終端機回答」或逾時（`DISCORD_SYNC_ASK_TIMEOUT` 秒，預設 600）就回到本地對話框 |
| 狀態 | Claude 工作中時頻道會顯示「正在輸入…」；session 結束後頻道移到「Claude Sessions (ended)」分類，用 `--resume` 回來時會移回原分類 |

## 安裝

需要 [Bun](https://bun.sh)；`!new` 另外需要 tmux。

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
  "showToolCalls": true,
  "notifyMinBusySec": 15,
  "attachOver": 3800
}
```

- `guildId`：bot 只在一個 guild 時會自動偵測。
- `allowFrom`：預設沿用官方外掛 `access.json` 的 `allowFrom`。**只有這些人能對 session 下指令或核准權限**，其他人的訊息會被標上 🚫 並忽略。
- `archiveCategoryName`：設成 `""` 表示 session 結束後不移動頻道。
- `backlog`：daemon 啟動時遇到已經在跑的 session，最多補貼多少則歷史訊息。
- `notifyMinBusySec`：Claude 至少工作幾秒才會發完成通知；設成 `-1` 表示關閉。
- `attachOver`：回覆超過幾個字就改成預覽加附檔。

狀態檔 `state.json`（session ↔ 頻道對應、讀取進度）也在同一個資料夾，daemon 重啟後會從上次的位置繼續，不會重複貼文。

## 已知限制

- transcript 的 JSONL 格式是 Claude Code 的內部格式，改版後可能需要調整 `src/render.ts`。
- `ccd` session 的選擇題在 Discord 等待作答期間，本地終端機不會出現對話框；要在本地回答，請在 Discord 按「改在終端機回答」或等待逾時。用一般 `claude` 啟動的 session 仍然只能在本地作答。
- `!stop` 的 `TIOCSTI` 方式在 Linux 6.2 以後的核心可能被關閉（`dev.tty.legacy_tiocsti=0`），這時只能靠 tmux 或 stop hook。stop hook 停不下正在跑的長指令，只會在下一次使用工具前生效。
- `/clear` 會產生新的 session ID，所以會開一個新頻道，舊頻道會被歸檔。
- 安全性：在 allowlist 裡的人，等於能在這台機器上透過 Claude 執行指令。guild 請保持私人。
