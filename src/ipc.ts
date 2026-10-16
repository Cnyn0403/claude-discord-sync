import type { Socket } from 'net'
import type { Key } from './keys'

/** Messages from a per-session channel server to the daemon. */
export type ClientMsg =
  /** tmux: the pane Claude Code runs in, if any (inherited TMUX / TMUX_PANE). */
  /** hookInput: channels aren't available with this login, so inbox-hook.ts carries Discord input instead. */
  | { t: 'hello'; claudePid: number; tmux?: { socket: string; pane: string }; hookInput?: boolean }
  | { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { t: 'send_file'; id: number; path: string; caption?: string }
  | { t: 'type_result'; ok: boolean; error?: string }
  /** From `claude-discord-sync pause|unpause` (own connection): one session (by Claude Code PID) or all. */
  | { t: 'pause'; paused: boolean; pid?: number }
  /** From ask-hook.ts (its own connection, no hello): AskUserQuestion to answer on Discord. */
  | { t: 'ask'; sessionId: string; questions: AskQuestion[] }
  /** From ask-hook.ts: ExitPlanMode plan to approve or send back on Discord. */
  | { t: 'plan'; sessionId: string; plan: string }
  /** From inbox-hook.ts (hook input, beta): wake this idle session with the next Discord messages. */
  | { t: 'inbox_wait'; sessionId: string }
  /** From inbox-hook.ts after a tool call: Discord messages that arrived while Claude was working. */
  | { t: 'inbox_poll'; sessionId: string }
  /** From inbox-hook.ts: a permission prompt to answer on Discord. */
  | { t: 'hook_permission'; sessionId: string; tool_name: string; description: string; input_preview: string }

export type AskQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  options: { label: string; description?: string }[]
}

/** Messages from the daemon to a channel server. */
export type DaemonMsg =
  | { t: 'message'; content: string; meta: Record<string, string> }
  | { t: 'permission'; request_id: string; behavior: 'allow' | 'deny' }
  | { t: 'result'; id: number; ok: boolean; error?: string }
  /** question text -> answer; undefined = answer in the local terminal instead. */
  | { t: 'ask_result'; answers?: Record<string, string> }
  | { t: 'plan_result'; approved: boolean; feedback?: string }
  /** /stop, /end: type keys into the session's terminal. */
  | { t: 'type'; keys: Key[] }
  | { t: 'pause_result'; text: string }
  /** To inbox-hook.ts: Discord messages for Claude (empty after a poll with nothing waiting). */
  | { t: 'inbox'; text: string }
  /** To a waiting inbox-hook.ts: a newer one took over, exit quietly. */
  | { t: 'inbox_close' }
  /** To inbox-hook.ts: the permission answer; none = answer in the terminal. */
  | { t: 'perm_result'; behavior?: 'allow' | 'deny' }

export function send(sock: Socket, msg: ClientMsg | DaemonMsg): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n')
}

/** Newline-delimited JSON reader. */
export function onLines<T>(sock: Socket, handler: (msg: T) => void): void {
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buf += chunk
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        handler(JSON.parse(line))
      } catch (e) {
        process.stderr.write(`discord-sync: bad ipc line: ${e}\n`)
      }
    }
  })
}
