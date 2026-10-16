#!/usr/bin/env bun
/**
 * Launch Claude Code with the discord-sync channel and hooks.
 *
 *   ccd [claude args…]                 spawn claude with the config below
 *   ccd --write-config                 write the config files and print their folder
 *                                      (the source checkout's bin/ccd uses this, then execs
 *                                      claude itself so Claude Code keeps the shell's PID)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLAUDE_DIR, STATE_DIR, readConfigFile } from './config'
import { USER_STATUSLINE_FILE } from './statusline'
import { IS_WIN } from './platform'
import { selfCommand } from './self'

// Forward slashes work in Windows APIs and in the shells hooks run under (sh / Git Bash / cmd).
const slash = (p: string) => p.replace(/\\/g, '/')
const q = (p: string) => `"${slash(p)}"`
/** A hook command line that runs one of our subcommands. */
const hook = (sub: string) => selfCommand(sub).map(q).join(' ')

/** Questions and plans wait this long on Discord before falling back to the terminal. */
const askTimeout = Number(process.env.DISCORD_SYNC_ASK_TIMEOUT) || 600

/** The user's own status line from ~/.claude/settings.json, which ours runs after saving Claude Code's snapshot. */
function userStatusLine(): { command?: string; padding?: number } {
  try {
    const sl = JSON.parse(readFileSync(join(CLAUDE_DIR, 'settings.json'), 'utf8')).statusLine
    return sl?.type === 'command' && typeof sl.command === 'string' ? { command: sl.command, padding: sl.padding } : {}
  } catch {
    return {}
  }
}

/** Waits for Discord messages while the session is idle (see inbox-hook.ts). */
const waiter = { type: 'command', command: hook('inbox-hook'), async: true, asyncRewake: true, timeout: 30 * 86_400 }

function writeConfig(): string {
  const dir = join(STATE_DIR, 'ccd')
  mkdirSync(dir, { recursive: true })
  const user = userStatusLine()
  writeFileSync(USER_STATUSLINE_FILE, user.command ?? '')
  const [command, ...args] = selfCommand('channel').map(slash)
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { 'discord-sync': { command, args } } }, null, 2))
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        // Our status line keeps Claude Code's usage snapshot for the daemon, then shows the user's own.
        statusLine: { type: 'command', command: hook('statusline'), ...(user.padding !== undefined ? { padding: user.padding } : {}) },
        hooks: {
          PreToolUse: [
            {
              matcher: 'AskUserQuestion|ExitPlanMode',
              hooks: [{ type: 'command', command: hook('ask-hook'), timeout: askTimeout + 30 }],
            },
            { matcher: '*', hooks: [{ type: 'command', command: hook('stop-hook') }] },
          ],
          // Hook input (beta), for logins without channels; inbox-hook exits at once when channels work.
          // asyncRewake hooks keep their timeout, so the idle waiters get a long one.
          ...(readConfigFile().input === 'channels'
            ? {}
            : {
                SessionStart: [{ hooks: [waiter] }],
                Stop: [{ hooks: [waiter] }],
                PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hook('inbox-hook'), timeout: 10 }] }],
                PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: hook('inbox-hook'), timeout: askTimeout + 30 }] }],
              }),
        },
      },
      null,
      2,
    ),
  )
  return dir
}

const dir = writeConfig()
if (process.argv[2] === '--write-config') {
  process.stdout.write(dir)
  process.exit(0)
}

const args = [
  '--mcp-config', join(dir, 'mcp.json'),
  '--settings', join(dir, 'settings.json'),
  '--dangerously-load-development-channels', 'server:discord-sync',
  ...process.argv.slice(2),
]
const claude = Bun.which('claude')
if (!claude) {
  console.error('ccd: `claude` not found on PATH')
  process.exit(1)
}
// npm installs a .cmd shim on Windows, which needs cmd.exe to run.
const cmd = IS_WIN && /\.(cmd|bat)$/i.test(claude) ? ['cmd.exe', '/d', '/s', '/c', claude, ...args] : [claude, ...args]
// Ctrl+C is meant for Claude Code (it shares our console / process group), not for this wrapper.
process.on('SIGINT', () => {})
const child = Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] })
process.exit(await child.exited)
