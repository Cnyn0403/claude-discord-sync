#!/usr/bin/env bun
/**
 * Hook input (beta): Discord -> Claude for logins without Claude Code channels
 * (Bedrock, Vertex, Foundry, API gateways). Installed by `ccd` on four events;
 * with channels available it exits at once and does nothing.
 *
 *   SessionStart, Stop  async + asyncRewake: wait for Discord messages while the
 *                       session is idle, then exit 2 with them on stderr, which
 *                       wakes Claude. The daemon keeps one waiter per session and
 *                       tells older ones to exit quietly.
 *   PostToolUse         messages that arrived while Claude was working, handed
 *                       over as additionalContext next to the tool result.
 *   PermissionRequest   ask on Discord; no answer, or "answer in terminal",
 *                       falls back to the normal dialog.
 */
import { connect, type Socket } from 'net'
import { SOCKET_PATH, useHookInput } from './config'
import { send, onLines, type ClientMsg, type DaemonMsg } from './ipc'

type HookInput = { session_id?: string; hook_event_name?: string; tool_name?: string; tool_input?: unknown }

const ASK_TIMEOUT_MS = (Number(process.env.DISCORD_SYNC_ASK_TIMEOUT) || 600) * 1000

/** Send one message and wait for the first reply `accept` takes; undefined on timeout or no daemon. */
function request<T extends DaemonMsg>(msg: ClientMsg, accept: (m: DaemonMsg) => m is T, timeoutMs: number): Promise<T | undefined> {
  return new Promise(resolve => {
    const sock = connect(SOCKET_PATH)
    const done = (reply?: T) => {
      sock.destroy()
      resolve(reply)
    }
    setTimeout(() => done(), timeoutMs)
    sock.on('connect', () => send(sock, msg))
    onLines<DaemonMsg>(sock, m => accept(m) && done(m))
    sock.on('error', () => done())
    sock.on('close', () => done())
  })
}

/** Wait for messages until the daemon hands some over or says another waiter took over; survives daemon restarts. */
function waitForMessages(sessionId: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let sock: Socket | undefined
    const attach = () => {
      sock = connect(SOCKET_PATH)
      sock.on('connect', () => send(sock!, { t: 'inbox_wait', sessionId }))
      onLines<DaemonMsg>(sock, m => {
        if (m.t === 'inbox') resolve(m.text)
        else if (m.t === 'inbox_close') resolve(undefined)
      })
      sock.on('error', () => {})
      sock.on('close', () => setTimeout(attach, 3000))
    }
    attach()
  })
}

function output(hookEventName: string, fields: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, ...fields } }))
}

try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput
  const sessionId = input.session_id
  const event = input.hook_event_name
  if (sessionId && useHookInput()) {
    if (event === 'SessionStart' || event === 'Stop') {
      const text = await waitForMessages(sessionId)
      if (text) {
        process.stderr.write(text)
        process.exit(2)
      }
    } else if (event === 'PostToolUse') {
      const r = await request({ t: 'inbox_poll', sessionId }, (m): m is Extract<DaemonMsg, { t: 'inbox' }> => m.t === 'inbox', 3000)
      if (r?.text) output('PostToolUse', { additionalContext: r.text })
    } else if (event === 'PermissionRequest' && input.tool_name) {
      const preview = JSON.stringify(input.tool_input ?? {})
      const r = await request(
        { t: 'hook_permission', sessionId, tool_name: input.tool_name, description: '', input_preview: preview.slice(0, 4000) },
        (m): m is Extract<DaemonMsg, { t: 'perm_result' }> => m.t === 'perm_result',
        ASK_TIMEOUT_MS,
      )
      if (r?.behavior) output('PermissionRequest', { decision: { behavior: r.behavior, ...(r.behavior === 'deny' ? { message: 'Denied on Discord.' } : {}) } })
    }
  }
} catch {}
process.exit(0)
