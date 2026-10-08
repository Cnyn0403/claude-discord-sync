import type { Socket } from 'net'

/** Messages from a per-session channel server to the daemon. */
export type ClientMsg =
  | { t: 'hello'; claudePid: number }
  | { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { t: 'send_file'; id: number; path: string; caption?: string }
  | { t: 'interrupt_result'; ok: boolean; error?: string }
  /** From ask-hook.ts (its own connection, no hello): AskUserQuestion to answer on Discord. */
  | { t: 'ask'; sessionId: string; questions: AskQuestion[] }
  /** From ask-hook.ts: ExitPlanMode plan to approve or send back on Discord. */
  | { t: 'plan'; sessionId: string; plan: string }

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
  /** !stop: press Esc in the session's terminal. */
  | { t: 'interrupt' }

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
