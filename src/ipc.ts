import type { Socket } from 'net'

/** Messages from a per-session channel server to the daemon. */
export type ClientMsg =
  | { t: 'hello'; claudePid: number }
  | { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  | { t: 'send_file'; id: number; path: string; caption?: string }

/** Messages from the daemon to a channel server. */
export type DaemonMsg =
  | { t: 'message'; content: string; meta: Record<string, string> }
  | { t: 'permission'; request_id: string; behavior: 'allow' | 'deny' }
  | { t: 'result'; id: number; ok: boolean; error?: string }

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
