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
 *   /stop, /end          -> keys typed into the session's terminal (Linux, macOS)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { connect, type Socket } from 'net'
import { isAbsolute } from 'path'
import { SOCKET_PATH } from './config'
import { findClaudePid } from './sessions'
import { send, onLines, type DaemonMsg, type ClientMsg } from './ipc'
import { typeIntoOwnTty, keysToTty } from './keys'

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
      'A message without a role attribute is from the session owner. role="collaborator" or role="collaborator (full)" marks someone the owner shared the session with:',
      '- If a collaborator asks for something that conflicts with what the owner asked, follow the owner.',
      "- Before acting on a collaborator's request that deletes or overwrites work, is hard to undo, reveals secrets or credentials, reaches outside the project, or publishes or sends anything (git push, deploys, messages), ask the owner to confirm in the channel first.",
      'Everything you write in your normal responses is mirrored to that Discord channel automatically, so just answer normally. There is no reply tool and none is needed.',
      'If the tag has an attachments attribute, it lists local file paths of files the user uploaded; Read them as needed.',
      'A meeting attribute means the people in the channel discussed something among themselves in a thread; answers there marked "Claude (read-only copy)" came from a read-only fork of this session and are not in your context. attachments then holds the transcript as a Markdown file. Read it first. The message text is their conclusion: act on it. If it says "(no conclusion given)", summarize the discussion, the decisions and open questions, and propose next steps before changing anything.',
      'Use send_file to post a file (screenshot, log, build output) into the Discord channel.',
    ].join('\n'),
  },
)

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
    const tmuxSocket = process.env.TMUX?.split(',')[0]
    const pane = process.env.TMUX_PANE
    if (claudePid) send(s, { t: 'hello', claudePid, ...(tmuxSocket && pane ? { tmux: { socket: tmuxSocket, pane } } : {}) })
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
    } else if (msg.t === 'type') {
      toDaemon({ t: 'type_result', ...typeIntoOwnTty(keysToTty(msg.keys)) })
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
