#!/usr/bin/env bun
/**
 * discord-sync daemon: one Discord bot connection for the whole machine.
 *
 * - Watches Claude Code's live-session registry (~/.claude/sessions/*.json).
 * - Creates one text channel per session and mirrors the session transcript into it.
 * - Accepts connections from per-session channel servers (channel-server.ts) over a
 *   Unix socket, and routes Discord messages / permission answers to them.
 */
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
  type Message,
  type Interaction,
} from 'discord.js'
import { createServer, type Socket } from 'net'
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, chmodSync, statSync } from 'fs'
import { basename, join } from 'path'
import { loadConfig, STATE_DIR, SOCKET_PATH } from './config'
import { scanSessions, findTranscript, JsonlTail, type LiveSession } from './sessions'
import { renderRecord, titleOf, pack, chunk, type Block, type RenderContext } from './render'
import { send as ipcSend, onLines, type ClientMsg } from './ipc'

const cfg = loadConfig()
const STATE_FILE = join(STATE_DIR, 'state.json')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const TICK_MS = 1500

type SessionState = {
  channelId: string
  cwd: string
  offset: number
  transcript?: string
  title?: string
  ended?: boolean
}
type State = { guildId?: string; categoryId?: string; archiveCategoryId?: string; sessions: Record<string, SessionState> }

function log(...args: unknown[]) {
  console.error(new Date().toISOString(), ...args)
}

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { sessions: {} }
  }
}
const state = loadState()
let stateDirty = false
function saveState() {
  if (!stateDirty) return
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, STATE_FILE)
  stateDirty = false
}

// ---- runtime tracking ----------------------------------------------------

type Tracked = {
  sessionId: string
  st: SessionState
  live?: LiveSession
  tail?: JsonlTail
  ctx: RenderContext
  lastTyping: number
}
const tracked = new Map<string, Tracked>()
const creating = new Set<string>()
/** claudePid -> connected channel server */
const peers = new Map<number, Socket>()

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
})
let guild: Guild

// Per-channel send queue keeps message order stable under Discord rate limits.
const queues = new Map<string, Promise<unknown>>()
function enqueue<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(channelId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    channelId,
    next.catch(e => log(`send to ${channelId} failed:`, e?.message ?? e)),
  )
  return next
}

async function channelOf(t: Tracked): Promise<TextChannel | undefined> {
  const ch = guild.channels.cache.get(t.st.channelId) ?? (await guild.channels.fetch(t.st.channelId).catch(() => null))
  return ch?.type === ChannelType.GuildText ? ch : undefined
}

async function post(t: Tracked, texts: string[]) {
  const ch = await channelOf(t)
  if (!ch) return
  for (const text of texts) {
    if (text.trim()) await enqueue(ch.id, () => ch.send({ content: text, allowedMentions: { parse: [] } }))
  }
}

// ---- guild / categories --------------------------------------------------

async function ensureCategory(name: string, cachedId: string | undefined): Promise<string> {
  if (cachedId && guild.channels.cache.get(cachedId)?.type === ChannelType.GuildCategory) return cachedId
  const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name)
  if (existing) return existing.id
  const created = await guild.channels.create({ name, type: ChannelType.GuildCategory })
  return created.id
}

function channelName(s: LiveSession): string {
  const base = basename(s.cwd) || 'root'
  const slug = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${slug || 'session'}-${s.sessionId.slice(0, 4)}`
}

function topicFor(sessionId: string, st: SessionState): string {
  return [st.title, `📂 ${st.cwd}`, `🆔 ${sessionId}`].filter(Boolean).join(' · ').slice(0, 1024)
}

function headerFor(t: Tracked): string {
  const s = t.live!
  const interactive = peers.has(s.pid)
  return [
    `🟢 **Session 開始同步**`,
    `📂 \`${s.cwd}\``,
    `🆔 \`${s.sessionId}\` · PID ${s.pid}`,
    interactive ? '💬 雙向模式：可以直接在這裡對 Claude 說話' : '👀 唯讀模式（這個 session 沒有載入 discord-sync channel）',
  ].join('\n')
}

// ---- session lifecycle ---------------------------------------------------

async function startTracking(s: LiveSession) {
  const prev = state.sessions[s.sessionId]
  const t: Tracked = {
    sessionId: s.sessionId,
    st: prev ?? { channelId: '', cwd: s.cwd, offset: 0 },
    live: s,
    ctx: { toolNames: new Map(), showToolCalls: cfg.showToolCalls },
    lastTyping: 0,
  }
  let ch = prev ? await channelOf(t) : undefined
  const transcript = findTranscript(s.sessionId, s.cwd)

  if (ch) {
    // Known session coming back (e.g. `claude --resume`); continue where we left off.
    if (prev!.ended) {
      if (ch.parentId !== state.categoryId) await ch.setParent(state.categoryId!, { lockPermissions: false }).catch(() => {})
      prev!.ended = false
      await post(t, [`🟢 **Session 恢復** · PID ${s.pid}`])
    }
  } else {
    ch = await guild.channels.create({
      name: channelName(s),
      type: ChannelType.GuildText,
      parent: state.categoryId,
      topic: topicFor(s.sessionId, t.st),
    })
    t.st.channelId = ch.id
    t.st.offset = 0
    await post(t, [headerFor(t)])
    if (transcript) {
      // Session predates the channel: show only the tail of its history.
      const tail = new JsonlTail(transcript)
      const blocks: Block[] = []
      for (const o of tail.read()) {
        t.st.title = titleOf(o) ?? t.st.title
        blocks.push(...renderRecord(o, t.ctx))
      }
      const shown = blocks.slice(-cfg.backlog)
      if (blocks.length > shown.length) await post(t, [`-# …（略過較早的 ${blocks.length - shown.length} 則）`])
      await post(t, pack(shown))
      t.st.offset = tail.offset
      if (t.st.title) await ch.setTopic(topicFor(s.sessionId, t.st)).catch(() => {})
    }
    log(`channel #${ch.name} created for ${s.sessionId}`)
  }
  if (transcript) {
    t.st.transcript = transcript
    t.tail = new JsonlTail(transcript, t.st.offset)
  }
  state.sessions[s.sessionId] = t.st
  stateDirty = true
  tracked.set(s.sessionId, t)
}

async function endTracking(t: Tracked) {
  pump(t)
  await post(t, ['🔴 **Session 已結束**'])
  t.st.ended = true
  stateDirty = true
  tracked.delete(t.sessionId)
  if (state.archiveCategoryId) {
    const ch = await channelOf(t)
    await ch?.setParent(state.archiveCategoryId, { lockPermissions: false }).catch(e => log('archive failed:', e?.message))
  }
}

function pump(t: Tracked) {
  if (!t.tail) {
    const p = findTranscript(t.sessionId, t.st.cwd)
    if (!p) return
    t.st.transcript = p
    t.tail = new JsonlTail(p, 0)
  }
  const records = t.tail.read()
  if (!records.length) return
  const blocks: Block[] = []
  let newTitle: string | undefined
  for (const o of records) {
    const title = titleOf(o)
    if (title && title !== t.st.title) newTitle = title
    blocks.push(...renderRecord(o, t.ctx))
  }
  t.st.offset = t.tail.offset
  stateDirty = true
  if (blocks.length) void post(t, pack(blocks))
  if (newTitle) {
    t.st.title = newTitle
    // Topic edits are rate limited (2 per 10 min per channel); titles change rarely.
    void channelOf(t).then(ch => ch?.setTopic(topicFor(t.sessionId, t.st)).catch(() => {}))
  }
}

let ticking = false
async function tick() {
  if (ticking) return
  ticking = true
  try {
    const live = scanSessions().filter(s => !s.kind || cfg.kinds.includes(s.kind))
    const liveIds = new Set(live.map(s => s.sessionId))

    for (const s of live) {
      const t = tracked.get(s.sessionId)
      if (t) {
        t.live = s
        continue
      }
      if (creating.has(s.sessionId)) continue
      creating.add(s.sessionId)
      startTracking(s)
        .catch(e => log(`start ${s.sessionId} failed:`, e?.message ?? e))
        .finally(() => creating.delete(s.sessionId))
    }

    for (const t of [...tracked.values()]) {
      if (!liveIds.has(t.sessionId)) {
        await endTracking(t).catch(e => log('end failed:', e?.message ?? e))
        continue
      }
      pump(t)
      // Typing indicator while Claude is working (lasts ~10s per call).
      if (t.live?.status === 'busy' && Date.now() - t.lastTyping > 8000) {
        t.lastTyping = Date.now()
        void channelOf(t).then(ch => ch?.sendTyping().catch(() => {}))
      }
    }

    // Sessions that ended while the daemon was down.
    for (const [sid, st] of Object.entries(state.sessions)) {
      if (!st.ended && !tracked.has(sid) && !creating.has(sid) && !liveIds.has(sid)) {
        const t: Tracked = { sessionId: sid, st, ctx: { toolNames: new Map(), showToolCalls: cfg.showToolCalls }, lastTyping: 0 }
        if (st.transcript) t.tail = new JsonlTail(st.transcript, st.offset)
        tracked.set(sid, t)
        await endTracking(t).catch(e => log('end failed:', e?.message ?? e))
      }
    }
  } finally {
    saveState()
    ticking = false
  }
}

// ---- Discord -> session --------------------------------------------------

function trackedByChannel(channelId: string): Tracked | undefined {
  for (const t of tracked.values()) if (t.st.channelId === channelId) return t
  return undefined
}

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

async function downloadAttachments(msg: Message): Promise<string[]> {
  const paths: string[] = []
  if (!msg.attachments.size) return paths
  mkdirSync(INBOX_DIR, { recursive: true })
  for (const att of msg.attachments.values()) {
    if (att.size > 25 * 1024 * 1024) continue
    const res = await fetch(att.url)
    if (!res.ok) continue
    const ext = (att.name.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1] ?? 'bin').toLowerCase()
    const p = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
    writeFileSync(p, Buffer.from(await res.arrayBuffer()))
    paths.push(p)
  }
  return paths
}

client.on('messageCreate', async (msg: Message) => {
  if (msg.author.bot || msg.guildId !== guild?.id) return
  const t = trackedByChannel(msg.channelId)
  if (!t) return
  if (!cfg.allowFrom.includes(msg.author.id)) {
    void msg.react('🚫').catch(() => {})
    return
  }
  const peer = t.live ? peers.get(t.live.pid) : undefined
  if (!peer) {
    void msg
      .reply('⚠️ 這個 session 是唯讀的（沒有載入 discord-sync channel）。要從 Discord 對話，請用 `ccd` 啟動 Claude Code。')
      .catch(() => {})
    return
  }
  const perm = PERMISSION_REPLY_RE.exec(msg.content)
  if (perm) {
    const behavior = perm[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
    ipcSend(peer, { t: 'permission', request_id: perm[2].toLowerCase(), behavior })
    void msg.react(behavior === 'allow' ? '✅' : '❌').catch(() => {})
    return
  }
  const files = await downloadAttachments(msg).catch(() => [] as string[])
  ipcSend(peer, {
    t: 'message',
    content: msg.content || (files.length ? '(attachment)' : ''),
    meta: {
      message_id: msg.id,
      user: msg.author.username,
      ts: msg.createdAt.toISOString(),
      ...(files.length ? { attachments: files.join('; ') } : {}),
    },
  })
  void msg.react('📨').catch(() => {})
})

client.on('interactionCreate', async (i: Interaction) => {
  if (!i.isButton()) return
  const m = /^perm:(allow|deny):(\d+):([a-km-z]{5})$/.exec(i.customId)
  if (!m) return
  if (!cfg.allowFrom.includes(i.user.id)) {
    await i.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {})
    return
  }
  const [, behavior, pid, request_id] = m
  const peer = peers.get(Number(pid))
  if (!peer) {
    await i.reply({ content: '這個 session 已經斷線。', ephemeral: true }).catch(() => {})
    return
  }
  ipcSend(peer, { t: 'permission', request_id, behavior: behavior as 'allow' | 'deny' })
  const label = behavior === 'allow' ? '✅ 已允許' : '❌ 已拒絕'
  await i.update({ content: `${i.message.content}\n\n**${label}**（${i.user.username}）`, components: [] }).catch(() => {})
})

// ---- channel-server connections -------------------------------------------

function trackedByPid(pid: number): Tracked | undefined {
  for (const t of tracked.values()) if (t.live?.pid === pid) return t
  return undefined
}

async function handlePeer(sock: Socket, msg: ClientMsg, self: { pid?: number }) {
  if (msg.t === 'hello') {
    self.pid = msg.claudePid
    peers.get(msg.claudePid)?.destroy()
    peers.set(msg.claudePid, sock)
    log(`channel server connected for pid ${msg.claudePid}`)
    const t = trackedByPid(msg.claudePid)
    if (t) await post(t, ['-# 🔗 discord-sync channel 已連線，可以在這裡對話'])
    return
  }
  const t = self.pid ? trackedByPid(self.pid) : undefined
  if (msg.t === 'permission_request') {
    if (!t) return
    const ch = await channelOf(t)
    if (!ch) return
    let preview = msg.input_preview
    try {
      preview = JSON.stringify(JSON.parse(preview), null, 2)
    } catch {}
    const body = chunk(
      [
        `🔐 **需要權限：${msg.tool_name}**`,
        msg.description,
        '```json\n' + preview.slice(0, 1200) + '\n```',
        `-# 也可以回覆 \`yes ${msg.request_id}\` / \`no ${msg.request_id}\``,
      ].join('\n'),
    )[0]
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${self.pid}:${msg.request_id}`).setLabel('允許').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${self.pid}:${msg.request_id}`).setLabel('拒絕').setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    const mentions = cfg.allowFrom.map(id => `<@${id}>`).join(' ')
    await enqueue(ch.id, () =>
      ch.send({ content: `${mentions}\n${body}`.slice(0, 2000), components: [row], allowedMentions: { users: cfg.allowFrom } }),
    )
    return
  }
  if (msg.t === 'send_file') {
    try {
      if (!t) throw new Error('session channel not found')
      const ch = await channelOf(t)
      if (!ch) throw new Error('session channel not found')
      if (statSync(msg.path).size > 25 * 1024 * 1024) throw new Error('file too large (max 25MB)')
      await enqueue(ch.id, () => ch.send({ content: msg.caption?.slice(0, 2000) || undefined, files: [msg.path] }))
      ipcSend(sock, { t: 'result', id: msg.id, ok: true })
    } catch (e: any) {
      ipcSend(sock, { t: 'result', id: msg.id, ok: false, error: String(e?.message ?? e) })
    }
  }
}

function startIpc() {
  rmSync(SOCKET_PATH, { force: true })
  const server = createServer(sock => {
    const self: { pid?: number } = {}
    onLines<ClientMsg>(sock, m => void handlePeer(sock, m, self).catch(e => log('peer msg failed:', e?.message ?? e)))
    sock.on('close', () => {
      if (self.pid && peers.get(self.pid) === sock) {
        peers.delete(self.pid)
        log(`channel server disconnected for pid ${self.pid}`)
      }
    })
    sock.on('error', () => {})
  })
  server.listen(SOCKET_PATH, () => chmodSync(SOCKET_PATH, 0o600))
}

// ---- boot -----------------------------------------------------------------

client.once('clientReady', async c => {
  log(`logged in as ${c.user.tag}`)
  const guildId = cfg.guildId ?? state.guildId ?? (c.guilds.cache.size === 1 ? c.guilds.cache.first()!.id : undefined)
  if (!guildId) {
    log(`bot is in ${c.guilds.cache.size} guilds; set "guildId" in ${join(STATE_DIR, 'config.json')}. Guilds:`)
    for (const g of c.guilds.cache.values()) log(`  ${g.id}  ${g.name}`)
    process.exit(1)
  }
  guild = await c.guilds.fetch(guildId)
  await guild.channels.fetch()
  const me = await guild.members.fetchMe()
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    log(`bot lacks "Manage Channels" in ${guild.name}; grant it and restart.`)
    process.exit(1)
  }
  if (!cfg.allowFrom.length) log('warning: allowFrom is empty, nobody can talk to sessions from Discord')
  if (state.guildId !== guild.id) {
    // Different guild than last time: old channel mappings are meaningless.
    state.guildId = guild.id
    state.categoryId = state.archiveCategoryId = undefined
    state.sessions = {}
  }
  state.categoryId = await ensureCategory(cfg.categoryName, state.categoryId)
  state.archiveCategoryId = cfg.archiveCategoryName ? await ensureCategory(cfg.archiveCategoryName, state.archiveCategoryId) : undefined
  stateDirty = true
  log(`syncing into ${guild.name} (${guild.id})`)
  startIpc()
  setInterval(() => void tick(), TICK_MS)
  void tick()
})

client.on('error', e => log('client error:', e.message))

function shutdown() {
  saveState()
  rmSync(SOCKET_PATH, { force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

client.login(cfg.token).catch(e => {
  log('login failed:', e.message)
  process.exit(1)
})
