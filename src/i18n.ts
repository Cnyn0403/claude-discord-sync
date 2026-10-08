/**
 * Discord-facing text. Pick the language with `"language"` in config.json.
 * Every locale must provide every key (the `Messages` type enforces it).
 */

const en = {
  // channel defaults
  consoleChannelName: 'claude-console',
  archiveForumName: 'claude-archive',

  // session lifecycle
  syncStarted: '🟢 **Session sync started**',
  twoWay: '💬 Two-way: you can talk to Claude right here',
  readOnly: '👀 Read-only (this session did not load the discord-sync channel)',
  resumed: (pid: number) => `🟢 **Session resumed** · PID ${pid}`,
  skippedOlder: (n: number) => `-# …(skipped ${n} earlier)`,
  sessionEnded: '🔴 **Session ended**',
  channelConnected: '-# 🔗 discord-sync channel connected, you can talk here',
  readOnlyReply: '⚠️ This session is read-only (it did not load the discord-sync channel). Start Claude Code with `ccd` to talk from Discord.',
  done: (duration: string) => `✅ Claude is done (${duration})`,
  duration: (min: number, sec: number) => (min ? `${min}m ${sec}s` : `${sec}s`),

  // rendering
  localInput: '👤 **Local input**',
  multiSelect: ' (multiple choice)',
  planPending: '📋 **Plan awaiting approval**',
  image: '[image]',
  toolFailed: (tool: string) => `-# ⚠️ ${tool} failed`,
  fullTextAttached: '-# 📎 Full text attached',

  // forum archive
  forumTopic: 'Ended Claude Code sessions. Press "▶️ Resume" in a post or type /resume to continue; deleting a post removes it from the lists.',
  olderOmitted: '…(earlier content omitted)',
  resume: 'Resume',
  endedAt: (ts: string) => `🔴 Ended ${ts}`,
  lastPrompt: (text: string) => `💬 Last message: ${text}`,
  resumeHint: '-# Press "Resume" or type `/resume` here to continue',

  // migration
  noForum: 'No forum configured (`archiveForumName` is empty).',
  alreadyMigrating: 'Already migrating.',
  nothingToMigrate: 'Nothing to migrate.',
  forumStillUnavailable: (err: string) => `⚠️ Still can't create the forum: ${err}`,
  migrating: (done: number, total: number) => `🗂️ Migrating… ${done}/${total}`,
  migrated: (moved: number, dropped: number) => `✅ Done: ${moved} moved to the forum, ${dropped} without a conversation deleted.`,
  migrateFailed: (n: number) => `⚠️ ${n} failed:`,

  // permissions
  permissionNeeded: (tool: string) => `🔐 **Permission needed: ${tool}**`,
  permissionReplyHint: (id: string) => `-# You can also reply \`yes ${id}\` / \`no ${id}\``,
  allow: 'Allow',
  deny: 'Deny',
  allowed: '✅ Allowed',
  denied: '❌ Denied',
  sessionDisconnected: 'This session has disconnected.',
  notAuthorized: 'Not authorized.',

  // questions
  other: 'Other (type it)…',
  otherDescription: 'Answer in text',
  otherTitle: 'Other',
  yourAnswer: 'Your answer',
  answerInTerminal: 'Answer in terminal',
  timedOut: '-# ⏱️ Timed out, answer in the terminal',
  answeringInTerminal: (user: string) => `-# ⌨️ Answering in the terminal (${user})`,
  answeredBy: (user: string) => `-# ✅ Answered by ${user}`,
  questionClosed: 'This question is already closed.',

  // plans
  planAttached: '-# 📎 Full plan attached',
  approve: 'Approve',
  revise: 'Revise',
  planHandled: 'This plan has already been handled.',
  whatToChange: 'What to change',
  revisePlan: 'Revise the plan',
  approvedBy: (user: string) => `**✅ Approved** (${user})`,
  revisionRequested: (user: string) => `**✏️ Revision requested** (${user})`,

  // new / resume
  newUsage: 'Usage: `!new <folder> [first message]`, e.g. `!new ~/proj why are the tests failing?`',
  folderNotFound: (dir: string) => `⚠️ Folder not found: \`${dir}\``,
  starting: (name: string) => `🚀 Started tmux \`${name}\`, waiting for the session to register…\n-# Take over locally with \`tmux attach -t ${name}\``,
  started: (name: string, channelId: string) => `✅ Started \`${name}\` → <#${channelId}>\n-# Take over locally with \`tmux attach -t ${name}\``,
  tmuxGone: (name: string) => `⚠️ tmux \`${name}\` has exited; Claude Code probably failed to start.`,
  startFailed: (code: string, screen: string) => `⚠️ Claude Code failed to start (exit ${code}). Last screen:\n${screen}`,
  startTimeout: (sec: number, screen: string) => `⚠️ No session registered within ${sec} s. Current screen:\n${screen}`,
  emptyScreen: '(empty)',

  // stop / end
  viaTmux: 'tmux',
  viaTerminal: 'terminal',
  noWayToType: 'this session is not in tmux and did not load the discord-sync channel',
  notBusy: 'Claude is not working right now.',
  escFailed: (err: string) => `⚠️ Couldn't press Esc: ${err}`,
  escFailedFallback: (err: string) => `⚠️ Couldn't press Esc (${err}); Claude will stop before its next tool call instead.`,
  escSent: (via: string) => `⏹️ Pressed Esc (${via}), checking…`,
  stillBusy: '⏹️ Pressed Esc, but Claude still looks busy; it will stop before its next tool call.',
  interrupted: '⏹️ Interrupted.',
  cantInterrupt: (err: string) => `⚠️ Couldn't interrupt the current work: ${err}`,
  cantEnd: (err: string) => `⚠️ Couldn't end the session: ${err}`,
  exitSent: (via: string) => `👋 Sent \`/exit\` (${via}), waiting for the session to end…`,
  endedCanResume: '👋 Session ended. Type `/resume` or `!resume` here to bring it back.',
  exitTimeout: '⚠️ The session is still running 15 s after `/exit`; a dialog may be in the way.',

  // command dispatcher
  stillRunning: 'This session is still running.',
  stillRunningAt: (channelId: string) => `This session is still running: <#${channelId}>`,
  notSessionChannel: 'This is not a session channel.',
  alreadyEnded: 'This session has already ended.',
  sessionNotFound: 'Session not found.',
  failed: (err: string) => `⚠️ Failed: ${err}`,

  // console
  busy: '🟡 Working',
  idle: '🟢 Idle',
  waiting: '⏳ Waiting',
  channelDeleted: '(channel deleted)',
  withinHour: 'within the hour',
  hoursAgo: (h: number) => `${h} h ago`,
  daysAgo: (d: number) => `${d} d ago`,
  endedAgo: (ago: string) => `ended ${ago}`,
  running: '**Running**',
  recentlyEnded: '**Recently ended**',
  none: '-# (none)',
  stopMenu: '⏹️ Interrupt a working session…',
  endMenu: '👋 End a session…',
  resumeMenu: '▶️ Resume an ended session…',
  newSession: 'New session',
  migrateButton: (n: number) => `Move ${n} old channels to the forum`,
  consoleTopic: 'Status of every Claude Code session; you can also type /new or !new here',
  folder: 'Folder',
  firstMessage: 'First message (optional)',
} as const

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : T[K] }
export type Messages = Widen<typeof en>

const zhTW: Messages = {
  consoleChannelName: 'claude-控制台',
  archiveForumName: 'claude-已結束',

  syncStarted: '🟢 **Session 開始同步**',
  twoWay: '💬 雙向模式：可以直接在這裡對 Claude 說話',
  readOnly: '👀 唯讀模式（這個 session 沒有載入 discord-sync channel）',
  resumed: pid => `🟢 **Session 恢復** · PID ${pid}`,
  skippedOlder: n => `-# …（略過較早的 ${n} 則）`,
  sessionEnded: '🔴 **Session 已結束**',
  channelConnected: '-# 🔗 discord-sync channel 已連線，可以在這裡對話',
  readOnlyReply: '⚠️ 這個 session 是唯讀的（沒有載入 discord-sync channel）。要從 Discord 對話，請用 `ccd` 啟動 Claude Code。',
  done: duration => `✅ Claude 完成了（${duration}）`,
  duration: (min, sec) => (min ? `${min} 分 ${sec} 秒` : `${sec} 秒`),

  localInput: '👤 **本地輸入**',
  multiSelect: '（可複選）',
  planPending: '📋 **計畫待確認**',
  image: '[圖片]',
  toolFailed: tool => `-# ⚠️ ${tool} 失敗`,
  fullTextAttached: '-# 📎 全文見附檔',

  forumTopic: '已結束的 Claude Code session。按貼文裡的「▶️ 恢復」或輸入 /resume 可以接著做；刪掉貼文就會從清單移除。',
  olderOmitted: '…（較早的內容已省略）',
  resume: '恢復',
  endedAt: ts => `🔴 結束於 ${ts}`,
  lastPrompt: text => `💬 最後說的話：${text}`,
  resumeHint: '-# 按「恢復」或在這裡輸入 `/resume` 可以接著做',

  noForum: '沒有設定論壇（`archiveForumName` 是空的）。',
  alreadyMigrating: '已經在搬了。',
  nothingToMigrate: '沒有需要搬的頻道。',
  forumStillUnavailable: err => `⚠️ 還是沒辦法建立論壇：${err}`,
  migrating: (done, total) => `🗂️ 搬移中… ${done}/${total}`,
  migrated: (moved, dropped) => `✅ 搬好了：${moved} 個搬到論壇，${dropped} 個沒有對話的直接刪除。`,
  migrateFailed: n => `⚠️ ${n} 個失敗：`,

  permissionNeeded: tool => `🔐 **需要權限：${tool}**`,
  permissionReplyHint: id => `-# 也可以回覆 \`yes ${id}\` / \`no ${id}\``,
  allow: '允許',
  deny: '拒絕',
  allowed: '✅ 已允許',
  denied: '❌ 已拒絕',
  sessionDisconnected: '這個 session 已經斷線。',
  notAuthorized: '你沒有權限。',

  other: '其他（自己輸入）…',
  otherDescription: '用文字回答',
  otherTitle: '其他',
  yourAnswer: '你的回答',
  answerInTerminal: '改在終端機回答',
  timedOut: '-# ⏱️ 已逾時，改在終端機回答',
  answeringInTerminal: user => `-# ⌨️ 改在終端機回答（${user}）`,
  answeredBy: user => `-# ✅ 已由 ${user} 回答`,
  questionClosed: '這個問題已經結束了。',

  planAttached: '-# 📎 完整計畫見附檔',
  approve: '核准',
  revise: '繼續修改',
  planHandled: '這個計畫已經處理過了。',
  whatToChange: '要修改的地方',
  revisePlan: '繼續修改計畫',
  approvedBy: user => `**✅ 已核准**（${user}）`,
  revisionRequested: user => `**✏️ 要求修改**（${user}）`,

  newUsage: '用法：`!new <資料夾> [第一句話]`，例如 `!new ~/proj 幫我看一下測試為什麼失敗`',
  folderNotFound: dir => `⚠️ 找不到資料夾 \`${dir}\``,
  starting: name => `🚀 已在 tmux \`${name}\` 啟動，等待 session 註冊…\n-# 本機可以用 \`tmux attach -t ${name}\` 接手`,
  started: (name, channelId) => `✅ 已啟動 \`${name}\` → <#${channelId}>\n-# 本機可以用 \`tmux attach -t ${name}\` 接手`,
  tmuxGone: name => `⚠️ tmux \`${name}\` 已經結束，Claude Code 可能啟動失敗。`,
  startFailed: (code, screen) => `⚠️ Claude Code 啟動失敗（exit ${code}），最後的畫面：\n${screen}`,
  startTimeout: (sec, screen) => `⚠️ ${sec} 秒內沒看到 session 啟動，目前畫面：\n${screen}`,
  emptyScreen: '(空白)',

  viaTmux: 'tmux',
  viaTerminal: '終端機',
  noWayToType: '這個 session 沒有在 tmux 裡，也沒有載入 discord-sync channel',
  notBusy: 'Claude 目前沒在工作。',
  escFailed: err => `⚠️ 送不出 Esc：${err}`,
  escFailedFallback: err => `⚠️ 送不出 Esc（${err}），改成在 Claude 下一次使用工具前停止。`,
  escSent: via => `⏹️ 已送出 Esc（${via}），確認中…`,
  stillBusy: '⏹️ 已送出 Esc，但 Claude 看起來還在工作，會在它下一次使用工具前停止。',
  interrupted: '⏹️ 已中斷。',
  cantInterrupt: err => `⚠️ 沒辦法中斷目前的工作：${err}`,
  cantEnd: err => `⚠️ 沒辦法結束：${err}`,
  exitSent: via => `👋 已送出 \`/exit\`（${via}），等待 session 結束…`,
  endedCanResume: '👋 Session 已結束，之後可以在這裡輸入 `/resume` 或 `!resume` 恢復。',
  exitTimeout: '⚠️ 送出 `/exit` 後 15 秒 session 還在，可能有對話框擋住了。',

  stillRunning: '這個 session 還在執行中。',
  stillRunningAt: channelId => `這個 session 還在執行中：<#${channelId}>`,
  notSessionChannel: '這裡不是 session 頻道。',
  alreadyEnded: '這個 session 已經結束了。',
  sessionNotFound: '找不到這個 session。',
  failed: err => `⚠️ 失敗：${err}`,

  busy: '🟡 工作中',
  idle: '🟢 閒置',
  waiting: '⏳ 等待中',
  channelDeleted: '（頻道已刪除）',
  withinHour: '1 小時內',
  hoursAgo: h => `${h} 小時前`,
  daysAgo: d => `${d} 天前`,
  endedAgo: ago => `結束於 ${ago}`,
  running: '**執行中**',
  recentlyEnded: '**最近結束**',
  none: '-# （沒有）',
  stopMenu: '⏹️ 中斷工作中的 session…',
  endMenu: '👋 結束 session…',
  resumeMenu: '▶️ 恢復已結束的 session…',
  newSession: '開新 session',
  migrateButton: n => `把 ${n} 個舊頻道搬到論壇`,
  consoleTopic: '所有 Claude Code session 的狀態；也可以在這裡輸入 /new 或 !new',
  folder: '資料夾',
  firstMessage: '第一句話（選填）',
}

export const LANGUAGES = { en, 'zh-TW': zhTW } as const satisfies Record<string, Messages>
export type Language = keyof typeof LANGUAGES

/** The active locale. Set once at startup by loadConfig(); a live binding for importers. */
export let m: Messages = en

export function setLanguage(lang: string | undefined): Language {
  const key = (lang && lang in LANGUAGES ? lang : 'en') as Language
  m = LANGUAGES[key]
  return key
}

/** Slash command descriptions, registered in every language so Discord can show each user their own. */
export const SLASH_DESCRIPTIONS = {
  new: { en: 'Start a new Claude Code session in tmux', 'zh-TW': '在 tmux 裡開一個新的 Claude Code session' },
  dir: { en: 'Folder', 'zh-TW': '資料夾' },
  prompt: { en: 'First message (optional)', 'zh-TW': '第一句話（選填）' },
  stop: { en: "Interrupt this session's current work (presses Esc)", 'zh-TW': '中斷這個 session 目前的工作（按 Esc）' },
  end: { en: 'End this session (/exit)', 'zh-TW': '結束這個 session（/exit）' },
  resume: { en: 'Resume this ended session', 'zh-TW': '恢復這個已結束的 session' },
  migrate: { en: 'Move old archived channels into the forum', 'zh-TW': '把舊的已結束頻道搬到論壇' },
} as const
