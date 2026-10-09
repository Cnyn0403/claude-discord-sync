#!/usr/bin/env bun
/**
 * Status line for ccd sessions. Claude Code hands the status line command a
 * JSON snapshot (context window use, plan rate limits, session totals) on
 * every update; this keeps it in status/<session>.json for the daemon's
 * /usage, console and context warnings, then runs the user's own status line
 * (saved by ccd.ts) with the same input, so the terminal looks as before.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config'
import { IS_WIN } from './platform'

export const STATUS_DIR = join(STATE_DIR, 'status')
export const USER_STATUSLINE_FILE = join(STATE_DIR, 'ccd', 'user-statusline.txt')

export async function run() {
  const input = await Bun.stdin.text()
  try {
    const data = JSON.parse(input)
    if (typeof data.session_id === 'string' && /^[\w-]{1,100}$/.test(data.session_id)) {
      mkdirSync(STATUS_DIR, { recursive: true })
      const file = join(STATUS_DIR, `${data.session_id}.json`)
      writeFileSync(`${file}.${process.pid}.tmp`, input)
      renameSync(`${file}.${process.pid}.tmp`, file)
    }
  } catch {}
  let user = ''
  try {
    user = readFileSync(USER_STATUSLINE_FILE, 'utf8').trim()
  } catch {}
  if (user) {
    const shell = IS_WIN ? ['cmd.exe', '/d', '/s', '/c', user] : ['sh', '-c', user]
    const proc = Bun.spawn(shell, { stdin: Buffer.from(input), stdout: 'inherit', stderr: 'inherit', windowsHide: true })
    process.exit(await proc.exited)
  }
}

if (import.meta.main) await run()
