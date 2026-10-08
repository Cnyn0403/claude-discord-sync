#!/usr/bin/env bun
/**
 * Launch Claude Code with the discord-sync channel and hooks.
 *
 *   bun src/ccd.ts [claude args…]      spawn claude (Windows, via bin/ccd.cmd)
 *   bun src/ccd.ts --write-config      write the config files and print their folder
 *                                      (bin/ccd uses this, then execs claude itself so
 *                                      Claude Code keeps the shell's PID, e.g. a tmux pane's)
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { STATE_DIR } from './config'
import { IS_WIN } from './platform'

const ROOT = resolve(import.meta.dir, '..')
// Forward slashes work in Windows APIs and in the shells hooks run under (sh / Git Bash / cmd).
const slash = (p: string) => p.replace(/\\/g, '/')
const BUN = slash(process.execPath)
const q = (p: string) => `"${slash(p)}"`

/** Questions and plans wait this long on Discord before falling back to the terminal. */
const askTimeout = Number(process.env.DISCORD_SYNC_ASK_TIMEOUT) || 600

function writeConfig(): string {
  const dir = join(STATE_DIR, 'ccd')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { 'discord-sync': { command: BUN, args: [slash(join(ROOT, 'src', 'channel-server.ts'))] } } }, null, 2),
  )
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'AskUserQuestion|ExitPlanMode',
              hooks: [{ type: 'command', command: `${q(BUN)} ${q(join(ROOT, 'src', 'ask-hook.ts'))}`, timeout: askTimeout + 30 }],
            },
            { matcher: '*', hooks: [{ type: 'command', command: `${q(BUN)} ${q(join(ROOT, 'src', 'stop-hook.ts'))}` }] },
          ],
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
