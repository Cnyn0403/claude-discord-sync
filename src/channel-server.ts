#!/usr/bin/env bun
/**
 * Per-session Claude Code channel server (MCP over stdio).
 *
 * Claude Code spawns one of these per session when launched with
 *   claude --dangerously-load-development-channels server:discord-sync
 * It connects to the discord-sync daemon over a Unix socket, identifies its
 * session by the parent Claude Code PID, and relays:
 *   Discord message      -> notifications/claude/channel            -> session
 *   permission prompt    -> daemon (buttons in the session channel)
 *   button / "yes xxxxx" -> notifications/claude/channel/permission -> session
 *   !stop                -> Esc injected into the session's terminal
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect, type Socket } from 'net'
import { isAbsolute } from 'path'
import { openSync, closeSync } from 'fs'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { SOCKET_PATH } from './config'
import { findClaudePid } from './sessions'
import { send, onLines, type DaemonMsg, type ClientMsg } from './ipc'

const claudePid = Number(process.env.CLAUDE_PID) || findClaudePid(process.ppid)

const mcp = new Server(
  { name: 'discord-sync', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        // Permission relay: the daemon only accepts answers from allowlisted Discord users.
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'This session is mirrored to a Discord channel by discord-sync. The user may be at the local terminal or on Discord.',
      'Messages typed on Discord arrive as <channel source="discord-sync" user="..." message_id="...">. Treat them as messages from the user.',
      'Everything you write in your normal responses is mirrored to that Discord channel automatically, so just answer normally. There is no reply tool and none is needed.',
      'If the tag has an attachments attribute, it lists local file paths of files the user uploaded; Read them as needed.',
      'Use send_file to post a file (screenshot, log, build output) into the Discord channel.',
    ].join('\n'),
  },
)

// ---- interrupt --------------------------------------------------------------

const TIOCSTI = 0x5412

/**
 * Press Esc in Claude Code's TUI. We inherit its controlling terminal, and
 * TIOCSTI queues bytes as if typed there. Linux 6.2+ can disable TIOCSTI
 * (dev.tty.legacy_tiocsti=0); the daemon then falls back to a stop hook.
 */
function injectEsc(): { ok: boolean; error?: string } {
  let fd: number | undefined
  try {
    const libc = dlopen('libc.so.6', { ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 } })
    fd = openSync('/dev/tty', 'r+')
    const rc = libc.symbols.ioctl(fd, TIOCSTI, ptr(new Uint8Array([0x1b])))
    return rc === 0 ? { ok: true } : { ok: false, error: 'TIOCSTI rejected' }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ---- daemon connection ----------------------------------------------------

let sock: Socket | undefined
let nextId = 1
const pending = new Map<number, (r: { ok: boolean; error?: string }) => void>()

function toDaemon(msg: ClientMsg): boolean {
  if (!sock || sock.destroyed) return false
  send(sock, msg)
  return true
}

function connectDaemon() {
  const s = connect(SOCKET_PATH)
  s.on('connect', () => {
    sock = s
    if (claudePid) send(s, { t: 'hello', claudePid })
    process.stderr.write(`discord-sync: connected to daemon (claude pid ${claudePid})\n`)
  })
  onLines<DaemonMsg>(s, msg => {
    if (msg.t === 'message') {
      void mcp
        .notification({ method: 'notifications/claude/channel', params: { content: msg.content, meta: msg.meta } })
        .catch(e => process.stderr.write(`discord-sync: deliver failed: ${e}\n`))
    } else if (msg.t === 'permission') {
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: msg.request_id, behavior: msg.behavior },
      })
    } else if (msg.t === 'interrupt') {
      toDaemon({ t: 'interrupt_result', ...injectEsc() })
    } else if (msg.t === 'result') {
      pending.get(msg.id)?.(msg)
      pending.delete(msg.id)
    }
  })
  s.on('error', () => {})
  s.on('close', () => {
    if (sock === s) sock = undefined
    for (const resolve of pending.values()) resolve({ ok: false, error: 'daemon disconnected' })
    pending.clear()
    // Daemon not running or restarted: keep retrying quietly.
    setTimeout(connectDaemon, 3000)
  })
}

// ---- MCP handlers ---------------------------------------------------------

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    toDaemon({ t: 'permission_request', ...params })
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_file',
      description: 'Post a local file (image, log, archive; max 25MB) into this session\'s Discord channel.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to send.' },
          caption: { type: 'string', description: 'Optional message text to go with the file.' },
        },
        required: ['path'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'send_file') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  const { path, caption } = (req.params.arguments ?? {}) as { path?: string; caption?: string }
  if (!path || !isAbsolute(path)) {
    return { content: [{ type: 'text', text: 'path must be an absolute path' }], isError: true }
  }
  const id = nextId++
  const result = await new Promise<{ ok: boolean; error?: string }>(resolve => {
    pending.set(id, resolve)
    if (!toDaemon({ t: 'send_file', id, path, caption })) {
      pending.delete(id)
      resolve({ ok: false, error: 'discord-sync daemon is not running' })
    }
  })
  return result.ok
    ? { content: [{ type: 'text', text: 'sent' }] }
    : { content: [{ type: 'text', text: `send failed: ${result.error}` }], isError: true }
})

await mcp.connect(new StdioServerTransport())
if (!claudePid) process.stderr.write('discord-sync: could not find parent Claude Code process; inbound disabled\n')
connectDaemon()
