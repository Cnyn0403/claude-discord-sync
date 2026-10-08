#!/usr/bin/env bun
/**
 * Interactive setup: bot token, server, allowlist, language, the `ccd`
 * shortcut, and starting the daemon at login. Safe to run again: existing
 * answers are offered as defaults and nothing is overwritten without asking.
 */
import { createInterface } from 'readline'
import { mkdirSync, writeFileSync, chmodSync } from 'fs'
import { CONFIG_FILE, ENV_FILE, STATE_DIR, findToken, readConfigFile } from './config'
import { IS_WIN, hasTmux } from './platform'
import { installShortcut, shortcutOnPath, addToUserPath, SHORTCUT, SHORTCUT_DIR } from './shortcut'
import { installAutostart, autostartInstalled, daemonRunning, logHint } from './autostart'

const text = {
  en: {
    welcome: '\nclaude-discord-sync setup\n',
    noClaude: '⚠️  `claude` was not found on PATH. Install Claude Code first: https://claude.com/claude-code',
    noTmux: "⚠️  tmux is not installed, so /new and /resume won't work from Discord (macOS: `brew install tmux`, Linux: `apt install tmux`).",
    step: (n: number, title: string) => `\n[${n}/5] ${title}`,
    tokenTitle: 'Discord bot',
    keepToken: (name: string) => `Found a token for the bot "${name}". Keep it?`,
    botGuide: [
      'Create a bot (one-time):',
      '  1. Open https://discord.com/developers/applications and click "New Application".',
      '  2. Go to "Bot", click "Reset Token" and copy the token.',
      '  3. On the same page, turn on "Message Content Intent" and save.',
    ].join('\n'),
    askToken: 'Paste the bot token (input is hidden): ',
    badToken: '✗ Discord rejected that token. Try again.',
    botOk: (name: string) => `✓ Logged in as ${name}`,
    noIntent: '✗ "Message Content Intent" is off. Turn it on under "Bot" in the developer portal, save, then press Enter.',
    serverTitle: 'Server',
    invite: (url: string) => `Invite the bot to a private server you own:\n  ${url}`,
    waitGuild: 'Press Enter once the bot has joined the server…',
    noGuild: "✗ The bot isn't in any server yet.",
    pickGuild: 'The bot is in several servers. Which one should it use?',
    guildOk: (name: string) => `✓ Using the server "${name}"`,
    userTitle: 'Who may control Claude',
    userGuide: 'Your Discord user ID: in Discord, open Settings → Advanced and turn on Developer Mode, then right-click your name → "Copy User ID".',
    askUser: 'Your Discord user ID:',
    badUser: '✗ A user ID is a 17–20 digit number.',
    shortcutTitle: 'The `ccd` command',
    shortcutOk: (p: string) => `✓ ${p}`,
    shortcutConflict: (p: string) => `⚠️  ${p} already exists and isn't ours; left it alone. Run \`claude-discord-sync ccd\` instead.`,
    pathHint: (dir: string) => `⚠️  ${dir} is not on your PATH. Add this to your shell profile:\n  export PATH="${dir}:$PATH"`,
    pathAdded: (dir: string) => `✓ Added ${dir} to your PATH (open a new terminal to use it)`,
    autostartTitle: 'Background service',
    alreadyRunning: '⚠️  A daemon is already running (probably started by hand). Stop it, then press Enter.',
    askAutostart: 'Start the daemon now and at every login?',
    autostartOk: (log: string) => `✓ Daemon running. Log: ${log}`,
    autostartFailed: (err: string) => `✗ Couldn't set up autostart: ${err}\n  You can run it by hand: claude-discord-sync daemon`,
    manualStart: 'Run the daemon yourself with: claude-discord-sync daemon',
    saved: (f: string) => `✓ Saved ${f}`,
    done: [
      '\nAll set! Next:',
      '  1. Open a new terminal and start Claude Code with `ccd` (instead of `claude`).',
      '  2. Confirm the "development channel" prompt Claude Code shows on startup.',
      '  3. A channel for the session appears under "Claude Sessions" in your server.',
      '\nCheck everything any time with: claude-discord-sync doctor',
    ].join('\n'),
    yes: 'Y/n',
    no: 'y/N',
  },
  'zh-TW': {
    welcome: '\nclaude-discord-sync 安裝設定\n',
    noClaude: '⚠️  找不到 `claude` 指令，請先安裝 Claude Code：https://claude.com/claude-code',
    noTmux: '⚠️  沒有安裝 tmux，從 Discord 用 /new、/resume 開 session 會無法使用（macOS：`brew install tmux`，Linux：`apt install tmux`）。',
    step: (n: number, title: string) => `\n[${n}/5] ${title}`,
    tokenTitle: 'Discord bot',
    keepToken: (name: string) => `找到 bot「${name}」的 token，要沿用嗎？`,
    botGuide: [
      '建立 bot（只需要做一次）：',
      '  1. 打開 https://discord.com/developers/applications，按「New Application」。',
      '  2. 到「Bot」頁面，按「Reset Token」並複製 token。',
      '  3. 在同一頁開啟「Message Content Intent」並儲存。',
    ].join('\n'),
    askToken: '貼上 bot token（輸入時不會顯示）：',
    badToken: '✗ Discord 不接受這個 token，請再試一次。',
    botOk: (name: string) => `✓ 已登入 ${name}`,
    noIntent: '✗「Message Content Intent」沒有開啟。請到開發者後台的「Bot」頁面開啟並儲存，然後按 Enter。',
    serverTitle: '伺服器',
    invite: (url: string) => `把 bot 邀請到你自己的私人伺服器：\n  ${url}`,
    waitGuild: 'bot 加入伺服器後，按 Enter 繼續…',
    noGuild: '✗ bot 還沒有加入任何伺服器。',
    pickGuild: 'bot 在好幾個伺服器裡，要用哪一個？',
    guildOk: (name: string) => `✓ 使用伺服器「${name}」`,
    userTitle: '誰可以操作 Claude',
    userGuide: '你的 Discord user ID：在 Discord 的「設定 → 進階」開啟開發者模式，然後在自己的名字上按右鍵 →「複製使用者 ID」。',
    askUser: '你的 Discord user ID：',
    badUser: '✗ user ID 是 17 到 20 位數的數字。',
    shortcutTitle: '`ccd` 指令',
    shortcutOk: (p: string) => `✓ ${p}`,
    shortcutConflict: (p: string) => `⚠️  ${p} 已經存在而且不是我們建立的，所以沒有動它。請改用 \`claude-discord-sync ccd\`。`,
    pathHint: (dir: string) => `⚠️  ${dir} 不在 PATH 裡，請把這行加進 shell 設定檔：\n  export PATH="${dir}:$PATH"`,
    pathAdded: (dir: string) => `✓ 已把 ${dir} 加進 PATH（開新的終端機後生效）`,
    autostartTitle: '背景服務',
    alreadyRunning: '⚠️  已經有一個 daemon 在執行（可能是手動啟動的）。請先停掉它，再按 Enter。',
    askAutostart: '要現在啟動 daemon，並在每次登入時自動啟動嗎？',
    autostartOk: (log: string) => `✓ daemon 已啟動，log：${log}`,
    autostartFailed: (err: string) => `✗ 沒辦法設定自動啟動：${err}\n  可以手動執行：claude-discord-sync daemon`,
    manualStart: '請自己執行 daemon：claude-discord-sync daemon',
    saved: (f: string) => `✓ 已儲存 ${f}`,
    done: [
      '\n設定完成！接下來：',
      '  1. 開一個新的終端機，用 `ccd` 啟動 Claude Code（取代 `claude`）。',
      '  2. Claude Code 啟動時會詢問 development channel，請按確認。',
      '  3. 伺服器的「Claude Sessions」分類裡會出現這個 session 的頻道。',
      '\n隨時可以用這個指令檢查：claude-discord-sync doctor',
    ].join('\n'),
    yes: 'Y/n',
    no: 'y/N',
  },
}
type Text = (typeof text)['en']

// ---- terminal input -----------------------------------------------------------

function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = fallback ? ` [${fallback}] ` : ' '
  return new Promise(resolve =>
    rl.question(question + suffix, answer => {
      rl.close()
      resolve(answer.trim() || fallback)
    }),
  )
}

async function confirm(t: Text, question: string, dflt = true): Promise<boolean> {
  const a = (await ask(`${question} (${dflt ? t.yes : t.no})`)).toLowerCase()
  return a ? a.startsWith('y') : dflt
}

/** Read a line without echoing it (shows * per character). */
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return ask(question)
  process.stdout.write(question)
  return new Promise(resolve => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value.trim())
          return
        }
        if (c === '\u0003') process.exit(130)
        if (c === '\u007f' || c === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else if (c >= ' ') {
          value += c
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

// ---- Discord REST -------------------------------------------------------------

const API = 'https://discord.com/api/v10'

async function discord<T>(token: string, path: string): Promise<T | undefined> {
  const res = await fetch(API + path, { headers: { Authorization: `Bot ${token}` } }).catch(() => undefined)
  return res?.ok ? ((await res.json()) as T) : undefined
}

type App = { id: string; name: string; flags?: number; bot?: { username: string } }
// GATEWAY_MESSAGE_CONTENT or GATEWAY_MESSAGE_CONTENT_LIMITED
const hasMessageContent = (app: App) => ((app.flags ?? 0) & ((1 << 18) | (1 << 19))) !== 0

/** View Channels, Manage Channels, Add Reactions, Send Messages, Attach Files, Read History, Manage Threads, Create Public Threads, Send in Threads. */
const PERMISSIONS = [10n, 4n, 6n, 11n, 15n, 16n, 34n, 35n, 38n].reduce((acc, bit) => acc | (1n << bit), 0n)

// ---- steps ----------------------------------------------------------------------

async function main() {
  const existing = readConfigFile()
  const langAnswer = await ask('Language / 語言: 1) English  2) 繁體中文', existing.language === 'zh-TW' ? '2' : '1')
  const language = langAnswer === '2' ? 'zh-TW' : 'en'
  const t: Text = text[language]
  console.log(t.welcome)
  if (!Bun.which('claude')) console.log(t.noClaude)
  if (!IS_WIN && !hasTmux()) console.log(t.noTmux)

  // 1. token
  console.log(t.step(1, t.tokenTitle))
  let token = findToken()
  let app = token ? await discord<App>(token, '/applications/@me') : undefined
  if (!(app && token && (await confirm(t, t.keepToken(app.bot?.username ?? app.name))))) {
    console.log(t.botGuide)
    for (;;) {
      token = await askHidden(t.askToken)
      app = token ? await discord<App>(token, '/applications/@me') : undefined
      if (app) break
      console.log(t.badToken)
    }
  }
  console.log(t.botOk(app!.bot?.username ?? app!.name))
  while (!hasMessageContent(app!)) {
    await ask(t.noIntent)
    app = (await discord<App>(token!, '/applications/@me')) ?? app
  }
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ENV_FILE, `DISCORD_BOT_TOKEN=${token}\n`)
  if (!IS_WIN) chmodSync(ENV_FILE, 0o600)
  console.log(t.saved(ENV_FILE))

  // 2. server
  console.log(t.step(2, t.serverTitle))
  let guilds = (await discord<{ id: string; name: string }[]>(token!, '/users/@me/guilds')) ?? []
  if (!guilds.length) {
    console.log(t.invite(`https://discord.com/oauth2/authorize?client_id=${app!.id}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`))
    while (!guilds.length) {
      await ask(t.waitGuild)
      guilds = (await discord<{ id: string; name: string }[]>(token!, '/users/@me/guilds')) ?? []
      if (!guilds.length) console.log(t.noGuild)
    }
  }
  let guild = guilds.find(g => g.id === existing.guildId) ?? guilds[0]
  if (guilds.length > 1) {
    console.log(t.pickGuild)
    guilds.forEach((g, i) => console.log(`  ${i + 1}) ${g.name}`))
    const n = Number(await ask('>', String(guilds.indexOf(guild) + 1)))
    guild = guilds[n - 1] ?? guild
  }
  console.log(t.guildOk(guild.name))

  // 3. allowlist
  console.log(t.step(3, t.userTitle))
  console.log(t.userGuide)
  let userId = ''
  for (;;) {
    userId = await ask(t.askUser, existing.allowFrom?.[0] ?? '')
    if (/^\d{17,20}$/.test(userId)) break
    console.log(t.badUser)
  }
  const allowFrom = [...new Set([userId, ...(existing.allowFrom ?? [])])]
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, language, guildId: guild.id, allowFrom }, null, 2) + '\n')
  console.log(t.saved(CONFIG_FILE))

  // 4. ccd
  console.log(t.step(4, t.shortcutTitle))
  if (installShortcut() === 'conflict') console.log(t.shortcutConflict(SHORTCUT))
  else console.log(t.shortcutOk(SHORTCUT))
  if (!shortcutOnPath()) {
    if (IS_WIN) {
      addToUserPath()
      console.log(t.pathAdded(SHORTCUT_DIR))
    } else {
      console.log(t.pathHint(SHORTCUT_DIR))
    }
  }

  // 5. daemon
  console.log(t.step(5, t.autostartTitle))
  if (await confirm(t, t.askAutostart)) {
    // A hand-started daemon would fight the autostarted one over the socket and the bot.
    while (!autostartInstalled() && (await daemonRunning())) await ask(t.alreadyRunning)
    try {
      installAutostart()
      console.log(t.autostartOk(logHint()))
    } catch (e: any) {
      console.log(t.autostartFailed(String(e?.stderr || e?.message || e).trim()))
    }
  } else {
    console.log(t.manualStart)
  }
  console.log(t.done)
  process.exit(0)
}

await main()
