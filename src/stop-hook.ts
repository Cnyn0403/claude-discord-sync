#!/usr/bin/env bun
/**
 * PreToolUse hook for every tool (installed by ccd): when !stop could not press
 * Esc, the daemon leaves a flag file for the session and this stops Claude
 * before its next tool call.
 */
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { STATE_DIR } from './config'

try {
  const { session_id } = JSON.parse(await Bun.stdin.text()) as { session_id?: string }
  const flag = session_id && /^[\w-]+$/.test(session_id) ? join(STATE_DIR, 'stop', session_id) : undefined
  if (flag && existsSync(flag)) {
    rmSync(flag, { force: true })
    process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Stopped from Discord' }))
  }
} catch {}
process.exit(0)
