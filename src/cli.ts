#!/usr/bin/env bun
/**
 * Single entry point, so the whole program can ship as one executable:
 *
 *   claude-discord-sync setup | update | uninstall | doctor | daemon [--log <file>] | ccd [claude args…]
 *
 * Internal subcommands (started by Claude Code or the daemon):
 *   channel, ask-hook, stop-hook, statusline, win-console
 */
import { appendFileSync } from 'fs'
import { format } from 'util'
import { VERSION } from './version'

const COMMANDS: Record<string, () => Promise<unknown>> = {
  setup: () => import('./setup'),
  update: () => import('./update'),
  pause: () => import('./pause').then(p => p.run(true)),
  unpause: () => import('./pause').then(p => p.run(false)),
  uninstall: () => import('./uninstall'),
  doctor: () => import('./doctor'),
  daemon: () => import('./daemon'),
  ccd: () => import('./ccd'),
  channel: () => import('./channel-server'),
  'ask-hook': () => import('./ask-hook'),
  'stop-hook': () => import('./stop-hook'),
  statusline: () => import('./statusline').then(s => s.run()),
  'win-console': () => import('./win-console'),
}

const sub = process.argv[2]
if (sub === 'version' || sub === '--version' || sub === '-v') {
  console.log(VERSION)
  process.exit(0)
}
const load = sub ? COMMANDS[sub] : undefined
if (!load) {
  console.log(`claude-discord-sync ${VERSION}

Usage:
  claude-discord-sync setup         set up the bot, config and autostart (interactive)
  claude-discord-sync ccd [args…]   start Claude Code with the Discord channel (same as \`ccd\`)
  claude-discord-sync doctor        check the bot, permissions and sessions (read-only)
  claude-discord-sync pause [all]   pause mirroring: this session when run inside one (e.g. \`! claude-discord-sync pause\`), else all
  claude-discord-sync unpause [all] resume mirroring
  claude-discord-sync daemon        run the daemon in the foreground
  claude-discord-sync update        update to the latest release (--pre: include prereleases)
  claude-discord-sync uninstall     remove the program, autostart and ccd (asks about your config)
  claude-discord-sync version`)
  process.exit(sub ? 1 : 0)
}

// The subcommand modules read their own arguments from process.argv.slice(2).
process.argv.splice(2, 1)

if (sub === 'daemon') {
  const i = process.argv.indexOf('--log')
  if (i > 1 && process.argv[i + 1]) {
    // Autostarted daemons have no terminal; append their log to a file instead.
    const file = process.argv[i + 1]
    const write = (...a: unknown[]) => appendFileSync(file, format(...a) + '\n')
    console.error = write
    console.log = write
  }
}

await load()
