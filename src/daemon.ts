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
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  type Guild,
  type TextChannel,
  type ForumChannel,
  type AnyThreadChannel,
  type Message,
  type Interaction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type MessageActionRowComponentBuilder,
  type RepliableInteraction,
  AttachmentBuilder,
  MessageFlags,
  SlashCommandBuilder,
  cleanContent,
} from 'discord.js'
import { createServer, type Socket } from 'net'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, chmodSync, statSync, readdirSync, openSync, readSync, closeSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { loadConfig, STATE_DIR, SOCKET_PATH } from './config'
import { scanSessions, findTranscript, isAlive, JsonlTail, type LiveSession } from './sessions'
import { renderRecord, titleOf, toolLabel, pack, chunk, type Block, type RenderContext, type Post } from './render'
import { send as ipcSend, onLines, type ClientMsg, type AskQuestion } from './ipc'
import { m, SLASH_DESCRIPTIONS } from './i18n'
import { IS_WIN, IS_LINUX, hasTmux, parentPid } from './platform'
import { COMPILED, selfCommand } from './self'
import { daemonRunning } from './autostart'
import { keysToTmux, type Key } from './keys'

const cfg = loadConfig()
/** Experimental: several computers share this bot and guild; this one's name. */
const MACHINE = cfg.machine
const CATEGORY_NAME = MACHINE ? `${cfg.categoryName} · ${MACHINE}` : cfg.categoryName
const CONSOLE_NAME = MACHINE && cfg.consoleChannelName ? `${cfg.consoleChannelName}-${MACHINE}` : cfg.consoleChannelName
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
  /** When the session ended (ms); drives the resume list order and old-channel cleanup. */
  endedAt?: number
  /** The user's latest message (local or Discord), to tell sessions apart in the console. */
  lastPrompt?: string
  /** Forum post this session was archived to (reused if it ends again after a resume). */
  archiveThreadId?: string
  /** People the owner shared this session with, by Discord user ID. */
  members?: Record<string, Role>
  /** Mirroring paused for this session; pausedSkipped counts what wasn't posted. */
  paused?: boolean
  pausedSkipped?: number
  /** A discussion among people in the channel, not sent to Claude until someone @-mentions the bot. */
  meeting?: Meeting
  /** The live "working…" message while Claude is busy, kept so a restarted daemon can remove it. */
  statusMessageId?: string
}

type Meeting = { startMessageId: string; startedAt: number; lastAt: number; reminded?: boolean }

/**
 * Access to a session. Owners (allowFrom) can do everything; the rest is per session:
 * viewer = read only, collab = talk to Claude, answer questions, /stop,
 * full = collab + approve permission prompts and plans.
 */
type Role = 'viewer' | 'collab' | 'full'
type Need = 'view' | 'chat' | 'approve' | 'owner'
const RANK = { viewer: 1, collab: 2, full: 3, owner: 4 } as const
const NEED_RANK: Record<Need, number> = { view: 1, chat: 2, approve: 3, owner: 4 }
type State = {
  /** Mirroring paused for every session on this machine. */
  pausedAll?: boolean
  guildId?: string
  categoryId?: string
  archiveCategoryId?: string
  archiveForumId?: string
  consoleChannelId?: string
  consoleMessageId?: string
  /** Multi-machine mode: the shared devices channel and this computer's entry in it. */
  devicesChannelId?: string
  deviceMessageId?: string
  sessions: Record<string, SessionState>
}

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

// ---- access ------------------------------------------------------------------

const isOwner = (userId: string) => cfg.allowFrom.includes(userId)

function accessOf(userId: string, st: SessionState | undefined): keyof typeof RANK | undefined {
  return isOwner(userId) ? 'owner' : st?.members?.[userId]
}

function can(userId: string, st: SessionState | undefined, need: Need): boolean {
  const a = accessOf(userId, st)
  return !!a && RANK[a] >= NEED_RANK[need]
}

/** Owners plus the members allowed to act on what's being announced, for @-mentions. */
function audience(st: SessionState | undefined, need: Need): string[] {
  const members = Object.entries(st?.members ?? {})
    .filter(([, r]) => RANK[r] >= NEED_RANK[need])
    .map(([id]) => id)
  return [...new Set([...cfg.allowFrom, ...members])]
}
const mentionsOf = (ids: string[]) => ids.map(id => `<@${id}>`).join(' ')

const isPaused = (st: SessionState) => !!(state.pausedAll || st.paused)

// ---- runtime tracking ----------------------------------------------------

type Tracked = {
  sessionId: string
  st: SessionState
  live?: LiveSession
  tail?: JsonlTail
  ctx: RenderContext
  lastTyping: number
  /** When the current busy stretch started, for the "done" notification. */
  busySince?: number
  /** A stop-hook flag file is waiting for this session's next tool call. */
  stopFlag?: boolean
  /** The tool Claude is running now (undefined: thinking or writing), for the status message. */
  activity?: { label: string; since: number }
  /** Messages were posted below the status message, so it should move back to the bottom. */
  statusStale?: boolean
  statusAt?: number
  statusUpdating?: boolean
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

async function post(t: Tracked, posts: Post[]) {
  const ch = await channelOf(t)
  if (!ch) return
  for (const p of posts) {
    if (typeof p === 'string') {
      if (p.trim()) await enqueue(ch.id, () => ch.send({ content: p, allowedMentions: { parse: [] } }))
    } else {
      const file = new AttachmentBuilder(Buffer.from(p.file, 'utf8'), { name: 'reply.md' })
      await enqueue(ch.id, () => ch.send({ content: p.content, files: [file], allowedMentions: { parse: [] } }))
    }
  }
  if (posts.length && t.st.statusMessageId) t.statusStale = true
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
    m.syncStarted,
    `📂 \`${s.cwd}\``,
    `🆔 \`${s.sessionId}\` · PID ${s.pid}`,
    interactive ? m.twoWay : m.readOnly,
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
  t.ctx.askOnDiscord = peers.has(s.pid)
  let ch = prev ? await channelOf(t) : undefined
  const transcript = findTranscript(s.sessionId, s.cwd)

  if (ch) {
    // Known session coming back (e.g. `claude --resume`); continue where we left off.
    if (prev!.ended) {
      if (ch.parentId !== state.categoryId) await ch.setParent(state.categoryId!, { lockPermissions: false }).catch(() => {})
      prev!.ended = false
      prev!.endedAt = undefined
      await post(t, [m.resumed(s.pid)])
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
    await applyMembers(ch, t.st)
    // Resumed after its channel was archived to the forum or deleted.
    t.st.ended = false
    t.st.endedAt = undefined
    await post(t, [headerFor(t)])
    if (transcript) {
      // Session predates the channel: show only the tail of its history.
      const tail = new JsonlTail(transcript)
      const blocks: Block[] = []
      for (const o of tail.read()) {
        t.st.title = titleOf(o) ?? t.st.title
        blocks.push(...renderRecord(o, t.ctx))
      }
      noteLastPrompt(t, blocks)
      const shown = blocks.slice(-cfg.backlog)
      if (blocks.length > shown.length) await post(t, [m.skippedOlder(blocks.length - shown.length)])
      await post(t, pack(shown, cfg.attachOver))
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
  await refreshStatus(t, false).catch(() => {})
  await post(t, [m.sessionEnded])
  t.st.ended = true
  t.st.endedAt = Date.now()
  stateDirty = true
  tracked.delete(t.sessionId)
  if (forumAvailable()) {
    try {
      await archiveToForum(t)
      return
    } catch (e: any) {
      log('forum archive failed, moving the channel to the archive category instead:', e?.message ?? e)
    }
  }
  await archiveToCategory(t)
}

/** Without a forum (disabled or not available in this guild): move the channel to the archive category. */
async function archiveToCategory(t: Tracked) {
  if (!cfg.archiveCategoryName) return
  state.archiveCategoryId = await ensureCategory(cfg.archiveCategoryName, state.archiveCategoryId)
  stateDirty = true
  const ch = await channelOf(t)
  await ch?.setParent(state.archiveCategoryId, { lockPermissions: false }).catch(e => log('archive failed:', e?.message))
}

// ---- forum archive ------------------------------------------------------------

/** When this guild last refused to create the forum; we retry after an hour (e.g. once Community is enabled). */
let forumFailedAt = 0
const forumAvailable = () => !!cfg.archiveForumName && Date.now() - forumFailedAt > 3_600_000

async function archiveForum(): Promise<ForumChannel> {
  const cached = state.archiveForumId ? guild.channels.cache.get(state.archiveForumId) : undefined
  if (cached?.type === ChannelType.GuildForum) return cached
  const found = guild.channels.cache.find(c => c.type === ChannelType.GuildForum && c.name === cfg.archiveForumName) as ForumChannel | undefined
  const forum =
    found ??
    (await guild.channels
      .create({
        name: cfg.archiveForumName,
        type: ChannelType.GuildForum,
        parent: state.categoryId,
        topic: m.forumTopic,
      })
      .catch(e => {
        forumFailedAt = Date.now()
        throw new Error(`cannot create forum channel: ${e?.message ?? e}`)
      }))
  state.archiveForumId = forum.id
  stateDirty = true
  return forum
}

/** The whole conversation as Markdown, for the archive post. */
function conversationMarkdown(st: SessionState): string | undefined {
  if (!st.transcript) return undefined
  const ctx: RenderContext = { toolNames: new Map(), showToolCalls: true }
  const blocks = new JsonlTail(st.transcript).read().flatMap(o => renderRecord(o, ctx))
  const md = blocks.map(b => b.text).join('\n\n')
  // Discord's default upload limit is 10 MB; keep the most recent part.
  return md.length > 9_000_000 ? m.olderOmitted + '\n\n' + md.slice(-9_000_000) : md
}

const resumeRow = (sessionId: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`resume:${sessionId}`).setLabel(m.resume).setEmoji('▶️').setStyle(ButtonStyle.Success),
  )

/**
 * Replace the session's text channel with a forum post: Discord can't move a
 * channel into a forum, so the post carries a summary and the full conversation.
 */
async function archiveToForum(t: Tracked) {
  const st = t.st
  const ch = await channelOf(t)
  if (ch) await queues.get(ch.id) // let pending mirror posts land first
  const forum = await archiveForum()
  const md = conversationMarkdown(st)
  const content = [
    MACHINE ? `💻 **${MACHINE}**` : '',
    `📂 \`${st.cwd}\``,
    `🆔 \`${t.sessionId}\``,
    m.endedAt(`<t:${Math.floor((st.endedAt ?? Date.now()) / 1000)}:f>`),
    st.lastPrompt ? m.lastPrompt(clip(st.lastPrompt, 300)) : '',
    m.resumeHint,
  ]
    .filter(Boolean)
    .join('\n')
  const message = {
    content,
    components: [resumeRow(t.sessionId)],
    files: md ? [new AttachmentBuilder(Buffer.from(md, 'utf8'), { name: 'conversation.md' })] : [],
  }
  let thread: AnyThreadChannel | undefined
  if (st.archiveThreadId) {
    // Ended again after a resume: add to the existing post.
    const prev = await guild.channels.fetch(st.archiveThreadId).catch(() => null)
    if (prev?.isThread()) {
      thread = prev
      if (thread.archived) await thread.setArchived(false).catch(() => {})
      await thread.send(message)
    }
  }
  if (!thread) {
    const name = clip(st.title || st.lastPrompt || basename(st.cwd) || t.sessionId, 100)
    const tag = MACHINE ? await machineTag(forum) : undefined
    thread = await forum.threads.create({ name, message, appliedTags: tag ? [tag] : [] })
  }
  // Point the session at the post before deleting the channel, so channelDelete doesn't forget it.
  st.archiveThreadId = st.channelId = thread.id
  stateDirty = true
  await ch?.delete('discord-sync: archived to forum').catch(e => log('delete after archive failed:', e?.message))
}

/**
 * Multi-machine mode: the forum tag named after this computer, created if
 * missing, so the forum can be filtered by computer. Undefined if the forum is
 * out of tags (Discord allows 20) or can't be edited.
 */
async function machineTag(forum: ForumChannel): Promise<string | undefined> {
  const name = MACHINE!.slice(0, 20)
  const find = () => forum.availableTags.find(t => t.name === name)?.id
  if (find()) return find()
  if (forum.availableTags.length >= 20) return undefined
  await forum.setAvailableTags([...forum.availableTags, { name, emoji: { id: null, name: '💻' } }]).catch(e => log('adding forum tag failed:', e?.message ?? e))
  return find()
}

/** Tag this computer's forum posts from before multi-machine mode (or before the tag existed). */
async function tagOwnPosts() {
  const forum = state.archiveForumId ? guild.channels.cache.get(state.archiveForumId) : undefined
  if (forum?.type !== ChannelType.GuildForum) return
  const tag = await machineTag(forum)
  if (!tag) return
  for (const st of Object.values(state.sessions)) {
    if (!st.ended || !st.archiveThreadId) continue
    const post = await guild.channels.fetch(st.archiveThreadId).catch(() => null)
    if (!post?.isThread() || post.appliedTags.includes(tag) || post.appliedTags.length >= 5) continue
    // Editing an archived post would reopen it; keep it closed afterwards.
    const wasArchived = post.archived
    if (wasArchived) await post.setArchived(false).catch(() => {})
    await post.setAppliedTags([...post.appliedTags, tag]).catch(() => {})
    if (wasArchived) await post.setArchived(true).catch(() => {})
  }
}

/** Ended sessions still archived the old way, as a text channel. */
function legacyArchived(): [string, SessionState][] {
  return Object.entries(state.sessions).filter(
    ([sid, st]) => st.ended && !tracked.has(sid) && guild.channels.cache.get(st.channelId)?.type === ChannelType.GuildText,
  )
}

let migrating = false

/**
 * Move old archived text channels into the forum. Sessions with no conversation
 * can't be resumed, so their channels are just deleted. The archive category is
 * removed once it's empty.
 */
async function migrateToForum(r: Replier) {
  if (!cfg.archiveForumName) return void (await r.reply(m.noForum))
  if (migrating) return void (await r.reply(m.alreadyMigrating))
  const items = legacyArchived()
  if (!items.length) return void (await r.reply(m.nothingToMigrate))
  migrating = true
  try {
    forumFailedAt = 0 // an explicit request: try again even if it failed recently
    try {
      await archiveForum()
    } catch (e: any) {
      return void (await r.reply(m.forumStillUnavailable(String(e?.message ?? e))))
    }
    const status = await r.reply(m.migrating(0, items.length))
    let moved = 0
    let dropped = 0
    const failed: string[] = []
    for (const [sid, st] of items) {
      const ch = guild.channels.cache.get(st.channelId)
      try {
        if (!st.transcript) {
          delete state.sessions[sid]
          stateDirty = true
          await ch?.delete('discord-sync: empty session')
          dropped++
        } else {
          await archiveToForum({ sessionId: sid, st, ctx: { toolNames: new Map(), showToolCalls: true }, lastTyping: 0 })
          moved++
        }
      } catch (e: any) {
        failed.push(`#${ch?.name ?? sid}：${e?.message ?? e}`)
      }
      await status.edit(m.migrating(moved + dropped + failed.length, items.length)).catch(() => {})
    }
    await Bun.sleep(1500) // let the channelDelete events update the category's children
    const cat = state.archiveCategoryId ? guild.channels.cache.get(state.archiveCategoryId) : undefined
    if (cat?.type === ChannelType.GuildCategory && cat.children.cache.size === 0) {
      await cat.delete('discord-sync: archive category is empty').catch(() => {})
      state.archiveCategoryId = undefined
      stateDirty = true
    }
    const lines = [m.migrated(moved, dropped)]
    if (failed.length) lines.push(m.migrateFailed(failed.length), ...failed.slice(0, 10).map(f => `- ${clip(f, 150)}`))
    await status.edit(clip(lines.join('\n'), 2000))
  } finally {
    migrating = false
  }
}

// ---- deleted channels ------------------------------------------------------------

/**
 * A live session's channel deleted: recreate it (next tick re-tracks the session and posts a backlog).
 * An ended session's channel or archive post deleted: forget the session.
 */
async function onChannelGone(id: string) {
  for (const t of tracked.values()) {
    if (t.st.channelId === id) {
      tracked.delete(t.sessionId)
      log(`channel of live session ${t.sessionId} deleted; recreating`)
      return
    }
  }
  for (const [sid, st] of Object.entries(state.sessions)) {
    if (st.ended && (st.channelId === id || st.archiveThreadId === id)) {
      delete state.sessions[sid]
      stateDirty = true
      log(`archive of ${sid} deleted; forgot the session`)
      return
    }
  }
  if (id === state.categoryId) {
    state.categoryId = await ensureCategory(CATEGORY_NAME, undefined)
    stateDirty = true
  }
}

client.on('channelDelete', ch => void onChannelGone(ch.id).catch(e => log('channelDelete failed:', e?.message ?? e)))
client.on('threadDelete', th => void onChannelGone(th.id).catch(e => log('threadDelete failed:', e?.message ?? e)))

function pump(t: Tracked) {
  if (!t.tail) {
    const p = findTranscript(t.sessionId, t.st.cwd)
    if (!p) return
    t.st.transcript = p
    t.tail = new JsonlTail(p, 0)
  }
  const records = t.tail.read()
  if (!records.length) return
  // ccd sessions post AskUserQuestion interactively via ask-hook.ts instead.
  t.ctx.askOnDiscord = !!t.live && peers.has(t.live.pid)
  const blocks: Block[] = []
  let newTitle: string | undefined
  for (const o of records) {
    trackActivity(t, o)
    const title = titleOf(o)
    if (title && title !== t.st.title) newTitle = title
    blocks.push(...renderRecord(o, t.ctx))
  }
  t.st.offset = t.tail.offset
  stateDirty = true
  if (isPaused(t.st)) {
    // Nothing from a paused stretch reaches Discord, not even the console's title / last prompt.
    t.st.pausedSkipped = (t.st.pausedSkipped ?? 0) + blocks.length
    return
  }
  noteLastPrompt(t, blocks)
  if (blocks.length) void post(t, pack(blocks, cfg.attachOver))
  if (newTitle) {
    t.st.title = newTitle
    // Topic edits are rate limited (2 per 10 min per channel); titles change rarely.
    void channelOf(t).then(ch => ch?.setTopic(topicFor(t.sessionId, t.st)).catch(() => {}))
  }
}

/** Follow the main thread's tool calls: a tool_use starts one, its result (or new text) ends it. */
function trackActivity(t: Tracked, o: any) {
  if (o?.isSidechain || !Array.isArray(o?.message?.content)) return
  for (const item of o.message.content) {
    if (o.type === 'assistant' && item?.type === 'tool_use') t.activity = { label: toolLabel(item.name, item.input), since: Date.now() }
    else if ((o.type === 'assistant' && item?.type === 'text') || (o.type === 'user' && item?.type === 'tool_result')) t.activity = undefined
  }
}

// ---- live status message ---------------------------------------------------

/** Quick turns get no status message; it appears once Claude has worked this long. */
const STATUS_AFTER_MS = 5000
const STATUS_EVERY_MS = 10_000
/** How soon a buried status message may move back to the bottom. */
const STATUS_MOVE_MS = 4000

function statusText(t: Tracked): string {
  const now = Date.now()
  const a = t.activity
  const doing = a ? m.statusTool(a.label, now - a.since >= 10_000 ? formatDuration(now - a.since) : undefined) : m.statusThinking
  return m.statusWorking(formatDuration(now - (t.busySince ?? now)), doing)
}

/** Show, update, move or remove the status message, at most one change at a time per session. */
function updateStatus(t: Tracked) {
  if (t.statusUpdating) return
  const show =
    cfg.liveStatus && t.live?.status === 'busy' && !isPaused(t.st) && t.busySince !== undefined && Date.now() - t.busySince >= STATUS_AFTER_MS
  if (!show && !t.st.statusMessageId) return
  if (show && t.st.statusMessageId && Date.now() - (t.statusAt ?? 0) < (t.statusStale ? STATUS_MOVE_MS : STATUS_EVERY_MS)) return
  t.statusUpdating = true
  refreshStatus(t, show)
    .catch(e => log('status update failed:', e?.message ?? e))
    .finally(() => (t.statusUpdating = false))
}

/** Edit the status message in place, or (when buried or gone) post a new one and delete the old. */
async function refreshStatus(t: Tracked, show: boolean) {
  const ch = await channelOf(t)
  if (!ch) return
  const old = t.st.statusMessageId
  if (!show) {
    if (!old) return
    t.st.statusMessageId = undefined
    t.statusStale = false
    stateDirty = true
    await enqueue(ch.id, () => ch.messages.delete(old)).catch(() => {})
    return
  }
  t.statusAt = Date.now()
  const content = statusText(t)
  if (old && !t.statusStale) {
    const edited = await enqueue(ch.id, () => ch.messages.edit(old, { content })).then(
      () => true,
      () => false,
    )
    if (edited) return
  }
  t.statusStale = false
  // No notification: it's replaced every few seconds.
  const sent = await enqueue(ch.id, () => ch.send({ content, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } }))
  t.st.statusMessageId = sent.id
  stateDirty = true
  if (old) await enqueue(ch.id, () => ch.messages.delete(old)).catch(() => {})
}

function noteLastPrompt(t: Tracked, blocks: Block[]) {
  const last = [...blocks].reverse().find(b => b.plain)?.plain
  if (last) t.st.lastPrompt = last.replace(/\s+/g, ' ').slice(0, 200)
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return m.duration(Math.floor(s / 60), s % 60)
}

/** @-mention the user when Claude finishes a turn, so they know to come back. */
function notifyWhenDone(t: Tracked) {
  const status = t.live?.status
  if (status === 'busy') {
    t.busySince ??= Date.now()
    return
  }
  if (status === 'idle') {
    if (t.stopFlag) clearStopFlag(t)
    // An interrupted tool never gets its result; don't carry it into the next turn.
    t.activity = undefined
  }
  // Other non-idle states (e.g. waiting on a prompt) keep the stretch open.
  if (status !== 'idle' || t.busySince === undefined) return
  const elapsed = Date.now() - t.busySince
  t.busySince = undefined
  if (cfg.notifyMinBusySec < 0 || elapsed < cfg.notifyMinBusySec * 1000 || !cfg.allowFrom.length || isPaused(t.st)) return
  // A pending question already pinged them.
  if ([...asks.values(), ...plans.values()].some(a => a.channelId === t.st.channelId)) return
  const who = audience(t.st, 'chat')
  void channelOf(t).then(ch => {
    if (!ch) return
    void enqueue(ch.id, () =>
      ch.send({ content: `${mentionsOf(who)} ${m.done(formatDuration(elapsed))}`, allowedMentions: { users: who } }),
    )
  })
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
      notifyWhenDone(t)
      updateStatus(t)
      remindIdleMeeting(t)
      // Typing indicator while Claude is working (lasts ~10s per call).
      if (t.live?.status === 'busy' && !isPaused(t.st) && Date.now() - t.lastTyping > 8000) {
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
    await updateConsole().catch(e => log('console update failed:', e?.message ?? e))
    await cleanupEnded().catch(e => log('cleanup failed:', e?.message ?? e))
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

/** Save one attachment to the inbox; undefined if it's over 25 MB or the download fails. */
async function downloadAttachment(att: import('discord.js').Attachment): Promise<string | undefined> {
  if (att.size > 25 * 1024 * 1024) return undefined
  const res = await fetch(att.url).catch(() => undefined)
  if (!res?.ok) return undefined
  mkdirSync(INBOX_DIR, { recursive: true })
  const ext = (att.name.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1] ?? 'bin').toLowerCase()
  const p = join(INBOX_DIR, `${Date.now()}-${att.id}.${ext}`)
  writeFileSync(p, Buffer.from(await res.arrayBuffer()))
  return p
}

async function downloadAttachments(msg: Message): Promise<string[]> {
  const paths: string[] = []
  for (const att of msg.attachments.values()) {
    const p = await downloadAttachment(att)
    if (p) paths.push(p)
  }
  return paths
}

client.on('messageCreate', async (msg: Message) => {
  if (msg.author.bot || msg.guildId !== guild?.id) return
  if (MACHINE && !ownsChannel(msg.channelId, parentOf(msg.channelId))) {
    // A ! command outside every computer's channels: one of them says where to use it.
    if (/^!(new|stop|end|resume|migrate|sync|model|mode)\b/i.test(msg.content.trim()) && isNeutral(msg.channelId) && isLeader()) void msg.reply(m.whichDevice(onlineNames())).catch(() => {})
    return
  }
  const cmd = /^!(new|stop|end|resume|migrate|sync|model|mode)(?:\s+([\s\S]*))?$/i.exec(msg.content.trim())
  if (cmd) {
    const name = cmd[1].toLowerCase()
    if (!can(msg.author.id, sessionByChannel(msg.channelId), name === 'stop' ? 'chat' : 'owner')) {
      void msg.react('🚫').catch(() => {})
      return
    }
    if (name === 'sync') {
      const on = (cmd[2] ?? '').trim().toLowerCase()
      if (on !== 'on' && on !== 'off') return void (await msg.reply(m.syncUsage))
      await setSync(messageReplier(msg), msg.channelId, on === 'on', msg.author.username)
      return
    }
    if (name === 'mode') {
      const mode = (cmd[2] ?? '').trim()
      if (!isMode(mode)) return void (await msg.reply(m.modeUsage))
      await setMode(messageReplier(msg), msg.channelId, mode)
      return
    }
    if (name === 'model') {
      const model = (cmd[2] ?? '').trim()
      if (!model) return void (await msg.reply(m.modelUsage))
      await setModel(messageReplier(msg), msg.channelId, model)
      return
    }
    const [dir, ...prompt] = (cmd[2] ?? '').split(/(?<=^\S+)\s+/)
    await runCommand(messageReplier(msg), msg.channelId, cmd[1].toLowerCase() as Command, dir || undefined, prompt.join(' ') || undefined)
    return
  }
  const t = trackedByChannel(msg.channelId)
  if (!t) return
  if (!can(msg.author.id, t.st, 'chat')) {
    void msg.react('🚫').catch(() => {})
    return
  }
  const peer = t.live ? peers.get(t.live.pid) : undefined
  if (!peer) {
    void msg
      .reply(m.readOnlyReply)
      .catch(() => {})
    return
  }
  // Permission answers work in any mode, meetings included.
  const perm = PERMISSION_REPLY_RE.exec(msg.content)
  if (perm) {
    if (!can(msg.author.id, t.st, 'approve')) {
      void msg.react('🚫').catch(() => {})
      return
    }
    const behavior = perm[1].toLowerCase().startsWith('y') ? 'allow' : 'deny'
    ipcSend(peer, { t: 'permission', request_id: perm[2].toLowerCase(), behavior })
    void msg.react(behavior === 'allow' ? '✅' : '❌').catch(() => {})
    return
  }
  // Meetings: @-mentioning people (but not the bot) starts one; messages stay among the
  // people until someone @-mentions the bot, which hands the whole discussion to Claude.
  // Only an explicit @: replying to one of the bot's messages pings it too, but shouldn't end a meeting.
  const mentionsBot = msg.mentions.has(client.user!, { ignoreRepliedUser: true, ignoreEveryone: true, ignoreRoles: true })
  if (t.st.meeting) {
    if (mentionsBot) await endMeeting(t, msg, peer)
    else {
      t.st.meeting.lastAt = Date.now()
      stateDirty = true
    }
    return
  }
  const people = msg.mentions.users.filter(u => !u.bot && u.id !== msg.author.id)
  if (people.size && !mentionsBot) {
    await startMeeting(t, msg, [...people.values()])
    return
  }
  if (isPaused(t.st)) {
    void msg.reply(m.pausedReply).catch(() => {})
    return
  }
  const files = await downloadAttachments(msg).catch(() => [] as string[])
  if (msg.content.trim()) {
    t.st.lastPrompt = msg.content.replace(/\s+/g, ' ').slice(0, 200)
    stateDirty = true
  }
  ipcSend(peer, {
    t: 'message',
    content: msg.content || (files.length ? '(attachment)' : ''),
    meta: {
      message_id: msg.id,
      user: msg.author.username,
      // Lets Claude tell the owner from someone they shared the session with.
      ...(isOwner(msg.author.id) ? {} : { role: roleTag(msg.author.id, t.st) }),
      ts: msg.createdAt.toISOString(),
      ...(files.length ? { attachments: files.join('; ') } : {}),
    },
  })
  void msg.react('📨').catch(() => {})
})

client.on('interactionCreate', async (i: Interaction) => {
  if (MACHINE && !(await routeHere(i))) return
  if (i.isAutocomplete() && i.commandName === 'new') {
    await i.respond(dirSuggestions(String(i.options.getFocused()))).catch(() => {})
    return
  }
  if (i.isAutocomplete() && i.commandName === 'model') {
    const typed = String(i.options.getFocused()).toLowerCase()
    await i.respond(MODEL_ALIASES.filter(a => a.includes(typed)).map(a => ({ name: a, value: a }))).catch(() => {})
    return
  }
  if (i.isChatInputCommand() && (SESSION_COMMANDS as readonly string[]).includes(i.commandName)) {
    await handleSessionCommand(i).catch(e => log('session command failed:', e?.message ?? e))
    return
  }
  if (i.isChatInputCommand() && (COMMANDS as readonly string[]).includes(i.commandName)) {
    if (!can(i.user.id, sessionByChannel(i.channelId), i.commandName === 'stop' ? 'chat' : 'owner')) {
      await i.reply({ content: m.notAuthorized, ephemeral: true }).catch(() => {})
      return
    }
    await i.deferReply()
    const r = interactionReplier(i)
    await runCommand(r, i.channelId, i.commandName as Command, i.options.getString('dir') ?? undefined, i.options.getString('prompt') ?? undefined)
    return
  }
  if (i.isButton() && i.customId.startsWith('resume:')) {
    if (!isOwner(i.user.id)) {
      await i.reply({ content: m.notAuthorized, ephemeral: true }).catch(() => {})
      return
    }
    const sid = i.customId.slice('resume:'.length)
    const st = state.sessions[sid]
    await i.deferReply()
    const r = interactionReplier(i)
    if (!st) await r.reply(m.sessionNotFound)
    else if (!st.ended) await r.reply(m.stillRunningAt(st.channelId))
    else await resumeSession(r, sid, st).catch(e => void r.reply(m.failed(String(e?.message ?? e))))
    return
  }
  if ((i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) && i.customId.startsWith('console:')) {
    await handleConsoleInteraction(i).catch(e => log('console interaction failed:', e?.message ?? e))
    return
  }
  if ((i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) && i.customId.startsWith('ask')) {
    await handleAskInteraction(i).catch(e => log('ask interaction failed:', e?.message ?? e))
    return
  }
  if ((i.isButton() || i.isModalSubmit()) && i.customId.startsWith('plan')) {
    await handlePlanInteraction(i).catch(e => log('plan interaction failed:', e?.message ?? e))
    return
  }
  if (!i.isButton()) return
  const match = /^perm:(allow|deny):(\d+):([a-km-z]{5})$/.exec(i.customId)
  if (!match) return
  const [, behavior, pid, request_id] = match
  if (!can(i.user.id, trackedByPid(Number(pid))?.st, 'approve')) {
    await i.reply({ content: m.notAuthorized, ephemeral: true }).catch(() => {})
    return
  }
  const peer = peers.get(Number(pid))
  if (!peer) {
    await i.reply({ content: m.sessionDisconnected, ephemeral: true }).catch(() => {})
    return
  }
  ipcSend(peer, { t: 'permission', request_id, behavior: behavior as 'allow' | 'deny' })
  const label = behavior === 'allow' ? m.allowed : m.denied
  await i.update({ content: `${i.message.content}\n\n**${label}**（${i.user.username}）`, components: [] }).catch(() => {})
})

// ---- AskUserQuestion on Discord --------------------------------------------

type PendingAsk = {
  sock: Socket
  channelId: string
  messageId?: string
  questions: AskQuestion[]
  answers: (string | undefined)[]
  /** Options picked alongside "other" while its modal is open. */
  picked: Map<number, string[]>
}
const asks = new Map<string, PendingAsk>()
const OTHER = 'other'

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function askContent(a: PendingAsk, footer?: string): string {
  const n = a.questions.length
  const parts = a.questions.map((q, i) => {
    const opts = q.options.map((o, j) => `  **${j + 1}.** ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
    const ans = a.answers[i]
    return `**❓ ${n > 1 ? `(${i + 1}) ` : ''}${q.question}**${q.multiSelect ? m.multiSelect : ''}\n${opts}${ans !== undefined ? `\n↳ ✅ **${ans}**` : ''}`
  })
  return clip([...parts, footer].filter(Boolean).join('\n\n'), 2000)
}

function askComponents(key: string, a: PendingAsk) {
  const rows = a.questions.map((q, i) => {
    const options = q.options.slice(0, 24).map((o, j) => ({
      label: clip(o.label, 100),
      value: String(j),
      ...(o.description ? { description: clip(o.description, 100) } : {}),
    }))
    options.push({ label: m.other, value: OTHER, description: m.otherDescription })
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ask:${key}:${i}`)
      .setPlaceholder(clip(`${a.questions.length > 1 ? `(${i + 1}) ` : ''}${q.header ? `[${q.header}] ` : ''}${q.question}`, 150))
      .setMinValues(1)
      .setMaxValues(q.multiSelect ? options.length : 1)
      .addOptions(options)
    return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)
  })
  rows.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`askterm:${key}`).setLabel(m.answerInTerminal).setEmoji('⌨️').setStyle(ButtonStyle.Secondary),
    ),
  )
  return rows.slice(0, 5)
}

async function startAsk(sock: Socket, sessionId: string, questions: AskQuestion[]) {
  const t = tracked.get(sessionId)
  const ch = t && (await channelOf(t))
  // Discord allows 5 component rows: up to 4 questions + the terminal button. Paused: answer locally.
  if (!ch || !questions.length || questions.length > 4 || isPaused(t.st)) {
    ipcSend(sock, { t: 'ask_result' })
    return
  }
  const key = Math.random().toString(36).slice(2, 10)
  const a: PendingAsk = { sock, channelId: ch.id, questions, answers: questions.map(() => undefined), picked: new Map() }
  asks.set(key, a)
  sock.on('close', () => {
    // Hook timed out or Claude Code moved on: retire the menus.
    if (asks.get(key) !== a) return
    asks.delete(key)
    if (a.messageId)
      void ch.messages.edit(a.messageId, { content: askContent(a, m.timedOut), components: [] }).catch(() => {})
  })
  const who = audience(t.st, 'chat')
  const sent = await enqueue(ch.id, () =>
    ch.send({
      content: clip(`${mentionsOf(who)}\n${askContent(a)}`, 2000),
      components: askComponents(key, a),
      allowedMentions: { users: who },
    }),
  )
  a.messageId = sent.id
}

async function handleAskInteraction(i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
  const match = /^ask(term|other)?:(\w+)(?::(\d+))?$/.exec(i.customId)
  if (!match) return
  const [, kind, key, qs] = match
  const a = asks.get(key)
  if (!can(i.user.id, trackedByChannel(a?.channelId ?? i.channelId ?? '')?.st, 'chat')) {
    await i.reply({ content: m.notAuthorized, ephemeral: true })
    return
  }
  if (!a) {
    await i.reply({ content: m.questionClosed, ephemeral: true })
    return
  }
  const update = (opts: { content: string; components: any[] }) =>
    i.isModalSubmit() ? (i.isFromMessage() ? i.update(opts) : i.reply(opts)) : i.update(opts)
  const settle = (answers: Record<string, string> | undefined, footer: string) => {
    asks.delete(key)
    ipcSend(a.sock, { t: 'ask_result', answers })
    return update({ content: askContent(a, footer), components: [] })
  }

  if (kind === 'term') {
    await settle(undefined, m.answeringInTerminal(i.user.username))
    return
  }
  const qi = Number(qs)
  const q = a.questions[qi]
  if (!q) return
  let answer: string
  if (i.isStringSelectMenu()) {
    const labels = i.values.filter(v => v !== OTHER).map(v => q.options[Number(v)]?.label ?? v)
    if (i.values.includes(OTHER)) {
      a.picked.set(qi, labels)
      const input = new TextInputBuilder()
        .setCustomId('text')
        .setLabel(clip(q.header || m.yourAnswer, 45))
        .setPlaceholder(clip(q.question, 100))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
      await i.showModal(
        new ModalBuilder()
          .setCustomId(`askother:${key}:${qi}`)
          .setTitle(m.otherTitle)
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
      )
      return
    }
    answer = labels.join(', ')
  } else if (i.isModalSubmit()) {
    answer = [...(a.picked.get(qi) ?? []), i.fields.getTextInputValue('text').trim()].join(', ')
    a.picked.delete(qi)
  } else {
    return
  }
  a.answers[qi] = answer
  if (a.answers.every(x => x !== undefined)) {
    const answers = Object.fromEntries(a.questions.map((q, j) => [q.question, a.answers[j]!]))
    await settle(answers, m.answeredBy(i.user.username))
  } else {
    await update({ content: askContent(a), components: askComponents(key, a) })
  }
}

// ---- ExitPlanMode on Discord ----------------------------------------------

type PendingPlan = { sock: Socket; channelId: string; messageId?: string; content: string }
const plans = new Map<string, PendingPlan>()

async function startPlan(sock: Socket, sessionId: string, plan: string) {
  const t = tracked.get(sessionId)
  const ch = t && (await channelOf(t))
  if (!ch || isPaused(t.st)) {
    ipcSend(sock, { t: 'ask_result' })
    return
  }
  const key = Math.random().toString(36).slice(2, 10)
  const who = audience(t.st, 'approve')
  const full = `${m.planPending}\n${plan}`
  // Long plans: preview in the message, full text attached.
  const long = full.length > 1800
  const p: PendingPlan = { sock, channelId: ch.id, content: long ? chunk(full, 1700)[0] + '\n' + m.planAttached : full }
  plans.set(key, p)
  sock.on('close', () => {
    if (plans.get(key) !== p) return
    plans.delete(key)
    if (p.messageId) void ch.messages.edit(p.messageId, { content: `${p.content}\n\n${m.timedOut}`, components: [] }).catch(() => {})
  })
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`plan:approve:${key}`).setLabel(m.approve).setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`plan:revise:${key}`).setLabel(m.revise).setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`plan:term:${key}`).setLabel(m.answerInTerminal).setEmoji('⌨️').setStyle(ButtonStyle.Secondary),
  )
  const sent = await enqueue(ch.id, () =>
    ch.send({
      content: `${mentionsOf(who)}\n${p.content}`.slice(0, 2000),
      components: [row],
      files: long ? [new AttachmentBuilder(Buffer.from(plan, 'utf8'), { name: 'plan.md' })] : [],
      allowedMentions: { users: who },
    }),
  )
  p.messageId = sent.id
}

async function handlePlanInteraction(i: ButtonInteraction | ModalSubmitInteraction) {
  const match = /^plan(?::(approve|revise|term)|fb):(\w+)$/.exec(i.customId)
  if (!match) return
  const [, action, key] = match
  const p = plans.get(key)
  if (!can(i.user.id, trackedByChannel(p?.channelId ?? i.channelId ?? '')?.st, 'approve')) {
    await i.reply({ content: m.notAuthorized, ephemeral: true })
    return
  }
  if (!p) {
    await i.reply({ content: m.planHandled, ephemeral: true })
    return
  }
  if (action === 'revise') {
    const input = new TextInputBuilder()
      .setCustomId('text')
      .setLabel(m.whatToChange)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
    await (i as ButtonInteraction).showModal(
      new ModalBuilder()
        .setCustomId(`planfb:${key}`)
        .setTitle(m.revisePlan)
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    )
    return
  }
  plans.delete(key)
  let footer: string
  if (action === 'approve') {
    ipcSend(p.sock, { t: 'plan_result', approved: true })
    footer = m.approvedBy(i.user.username)
  } else if (action === 'term') {
    ipcSend(p.sock, { t: 'ask_result' })
    footer = m.answeringInTerminal(i.user.username)
  } else {
    const feedback = (i as ModalSubmitInteraction).fields.getTextInputValue('text').trim()
    ipcSend(p.sock, { t: 'plan_result', approved: false, feedback })
    footer = `${m.revisionRequested(i.user.username)}\n${quoteLines(feedback)}`
  }
  const opts = { content: `${p.content}\n\n${footer}`.slice(0, 2000), components: [] }
  if (i.isModalSubmit() && !i.isFromMessage()) await i.reply(opts)
  else await (i as ButtonInteraction).update(opts)
}

const quoteLines = (s: string) => s.split('\n').map(l => '> ' + l).join('\n')

// ---- !new: start a ccd session in tmux --------------------------------------

const run = promisify(execFile)
/**
 * How tmux starts ccd. From a source checkout, bin/ccd execs claude so the pane's
 * process is Claude Code itself; the compiled binary has to spawn it as a child.
 */
const CCD_TMUX = COMPILED ? selfCommand('ccd') : [resolve(import.meta.dir, '..', 'bin', 'ccd')]
const NEW_TIMEOUT_MS = 45_000
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Startup dialogs a headless ccd would hang on, and the option that accepts them.
 * The cursor (❯) is moved down to that option before pressing Enter, since the
 * default is not always the accepting one (the trust dialog defaults to "No, exit").
 */
const STARTUP_PROMPTS: { re: RegExp; accept?: RegExp }[] = [
  { re: /development channel/i },
  { re: /Is this a project you created or one you trust/i, accept: /Yes, I trust this folder/i },
]

/** Keys to press for a startup dialog: Enter if the cursor is on the accepting option, else Down. */
function dialogKey(screen: string, accept: RegExp | undefined): 'Enter' | 'Down' {
  if (!accept) return 'Enter'
  const cursor = screen.split('\n').find(l => /^\s*❯/.test(l))
  return !cursor || accept.test(cursor) ? 'Enter' : 'Down'
}

const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, homedir())

/** `new <dir> [prompt]`: launch `ccd` in a detached tmux session; its channel appears once it registers. */
async function startNewSession(r: Replier, dirArg: string | undefined, prompt: string | undefined) {
  if (!dirArg) {
    await r.reply(m.newUsage)
    return
  }
  const dir = resolve(expandHome(dirArg))
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    await r.reply(m.folderNotFound(dir))
    return
  }
  await launchSession(r, dir, prompt ? [prompt.trim()] : [])
}

/** `resume` for an ended session: `ccd --resume <id>` in tmux; the channel moves back when it registers. */
async function resumeSession(r: Replier, sessionId: string, st: SessionState) {
  if (!statSync(st.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    await r.reply(m.folderNotFound(st.cwd))
    return
  }
  await launchSession(r, st.cwd, ['--resume', sessionId], sessionId)
}

/** A ccd started by /new or /resume, watched until it registers as a session. */
type Launch = {
  /** How the user can find it locally, e.g. tmux `ccd-ab12` */
  name: string
  hint: string
  /** The current screen, plus `dead` (exit status) once the process is gone; undefined if it vanished. */
  poll(): Promise<{ screen: string; dead?: string } | undefined>
  press(key: 'Enter' | 'Down'): Promise<unknown>
  owns(t: Tracked): boolean
  registered(): Promise<unknown>
}

/** Detached tmux session (Linux, macOS). `exec` makes the pane's process Claude Code itself, so pane_pid identifies it. */
async function startInTmux(dir: string, args: string[]): Promise<Launch> {
  const name = `ccd-${Math.random().toString(36).slice(2, 6)}`
  const cmd = ['exec', ...CCD_TMUX.map(shq), ...args.map(shq)].join(' ')
  // remain-on-exit keeps the screen around if it dies during startup, so we can show why.
  const { stdout } = await run('tmux', [
    'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', name, '-x', '200', '-y', '50', '-c', dir, cmd,
    ';', 'set-option', '-t', name, 'remain-on-exit', 'on',
  ])
  const panePid = Number(stdout.trim())
  return {
    name: `tmux \`${name}\``,
    hint: m.tmuxHint(name),
    async poll() {
      try {
        const screen = (await run('tmux', ['capture-pane', '-p', '-t', name])).stdout
        const dead = (await run('tmux', ['display-message', '-p', '-t', name, '#{pane_dead} #{pane_dead_status}'])).stdout.trim()
        if (!dead.startsWith('1')) return { screen }
        await run('tmux', ['kill-session', '-t', name]).catch(() => {})
        return { screen, dead: dead.split(' ')[1] || '?' }
      } catch {
        return undefined
      }
    },
    press: key => run('tmux', ['send-keys', '-t', name, key]),
    owns: t => !!t.live && (t.live.pid === panePid || parentPid(t.live.pid) === panePid),
    registered: () => run('tmux', ['set-option', '-t', name, 'remain-on-exit', 'off']).catch(() => {}),
  }
}

/** Quote one argument for the Windows command line (CommandLineToArgvW rules). */
const winArg = (a: string) => '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`
const samePath = (a: string, b: string) => (IS_WIN ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))

/**
 * New console window (Windows, no tmux). Its screen is read and typed into by
 * attaching to the console of the process we started. Claude Code is a child of
 * that process, so it's recognised by folder and start time (or by ID on resume).
 */
async function startInConsole(dir: string, args: string[], resumeId?: string): Promise<Launch> {
  const launchedAt = Date.now()
  const [exe, ...ccdArgs] = selfCommand('ccd', ...args)
  const ps = `$p = Start-Process -PassThru -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ArgumentList ${psq(ccdArgs.map(winArg).join(' '))}; $p.Id`
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
  const pid = Number(stdout.trim())
  let last = ''
  return {
    name: `PID ${pid}`,
    hint: m.windowHint,
    async poll() {
      if (!isAlive({ pid })) return { screen: last, dead: '?' }
      const r = await winConsole('screen', pid)
      if (r.ok && r.text !== undefined) last = r.text
      return { screen: last }
    },
    press: key => winConsole('type', pid, [key]),
    owns: t =>
      !!t.live &&
      (resumeId ? t.sessionId === resumeId : samePath(t.live.cwd, dir) && (t.live.startedAt ?? 0) >= launchedAt - 5000),
    registered: async () => {},
  }
}

/** Start ccd for /new or /resume, accept its startup dialogs, and report its channel once it registers. */
async function launchSession(r: Replier, dir: string, args: string[], resumeId?: string) {
  let l: Launch
  if (hasTmux()) l = await startInTmux(dir, args)
  else if (IS_WIN) l = await startInConsole(dir, args, resumeId)
  else return void (await r.reply(m.needTmux))
  const status = await r.reply(m.starting(l.name, l.hint))

  const answered = new Set<RegExp>()
  let downs = 0
  const deadline = Date.now() + NEW_TIMEOUT_MS
  let screen = ''
  while (Date.now() < deadline) {
    await Bun.sleep(1000)
    const t = [...tracked.values()].find(t => l.owns(t))
    if (t?.st.channelId) {
      await l.registered()
      await status.edit(m.started(l.name, t.st.channelId, l.hint))
      return
    }
    const p = await l.poll()
    if (!p) return void (await status.edit(m.launchGone(l.name)))
    screen = p.screen
    if (p.dead !== undefined) return void (await status.edit(m.startFailed(p.dead, screenBlock(screen))))
    const prompt = STARTUP_PROMPTS.find(p => p.re.test(screen) && !answered.has(p.re))
    if (prompt) {
      const key = downs < 5 ? dialogKey(screen, prompt.accept) : 'Enter'
      if (key === 'Enter') {
        answered.add(prompt.re)
        downs = 0
      } else {
        downs++
      }
      await l.press(key)
    }
  }
  await status.edit(m.startTimeout(NEW_TIMEOUT_MS / 1000, screenBlock(screen)))
}

function screenBlock(screen: string): string {
  const tail = screen.split('\n').filter(l => l.trim()).slice(-20).join('\n') || m.emptyScreen
  return '```\n' + tail.replace(/```/g, 'ˋˋˋ').slice(-1700) + '\n```'
}

// ---- !stop: interrupt the current turn ---------------------------------------

const STOP_DIR = join(STATE_DIR, 'stop')
const interruptWaiters = new Map<Socket, (r: { ok: boolean; error?: string }) => void>()

function setStopFlag(t: Tracked) {
  mkdirSync(STOP_DIR, { recursive: true })
  writeFileSync(join(STOP_DIR, t.sessionId), '')
  t.stopFlag = true
}

function clearStopFlag(t: Tracked) {
  rmSync(join(STOP_DIR, t.sessionId), { force: true })
  t.stopFlag = false
}

/** tmux panes reported by channel servers (from the TMUX / TMUX_PANE they inherit), by Claude Code PID. */
const peerTmux = new Map<number, { socket: string; pane: string }>()

/** The tmux pane Claude Code runs in: as its channel server reported, or (Linux) from its environment. */
function tmuxPaneOf(pid: number): { socket: string; pane: string } | undefined {
  const reported = peerTmux.get(pid)
  if (reported || !IS_LINUX) return reported
  try {
    const env = new Map(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)] as const),
    )
    const socket = env.get('TMUX')?.split(',')[0]
    const pane = env.get('TMUX_PANE')
    return socket && pane ? { socket, pane } : undefined
  } catch {
    return undefined
  }
}

function typeViaPeer(peer: Socket, keys: Key[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      interruptWaiters.delete(peer)
      resolve({ ok: false, error: 'channel server did not answer' })
    }, 3000)
    interruptWaiters.set(peer, r => {
      clearTimeout(timer)
      interruptWaiters.delete(peer)
      resolve(r)
    })
    ipcSend(peer, { t: 'type', keys })
  })
}


/** Windows: attach to the process's console in a helper process and type there / read the screen. */
async function winConsole(cmd: 'type' | 'screen', pid: number, keys?: Key[]): Promise<{ ok: boolean; error?: string; text?: string }> {
  try {
    const [exe, ...args] = selfCommand('win-console', cmd, String(pid), ...(keys ? [JSON.stringify(keys)] : []))
    const { stdout } = await run(exe, args, { windowsHide: true })
    return JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * Type into the session: via tmux when it runs in tmux, through its console on
 * Windows, otherwise through the channel server's terminal (TIOCSTI).
 */
async function typeInto(pid: number, peer: Socket | undefined, keys: Key[]): Promise<{ via?: string; error?: string }> {
  const tmux = tmuxPaneOf(pid)
  if (tmux) {
    try {
      for (const k of keysToTmux(keys)) await run('tmux', ['-S', tmux.socket, 'send-keys', '-t', tmux.pane, ...k])
      return { via: m.viaTmux }
    } catch (e: any) {
      return { error: e?.message ?? String(e) }
    }
  }
  if (IS_WIN) {
    const r = await winConsole('type', pid, keys)
    return r.ok ? { via: m.viaTerminal } : { error: r.error }
  }
  if (peer) {
    const r = await typeViaPeer(peer, keys)
    return r.ok ? { via: m.viaTerminal } : { error: r.error }
  }
  return { error: m.noWayToType }
}

/**
 * Press Esc in the session: via tmux when it runs in tmux, otherwise via the
 * channel server's terminal. If that fails or doesn't take, leave a flag for
 * stop-hook.ts to stop Claude before its next tool call.
 */
async function stopSession(t: Tracked, r: Replier, peer: Socket | undefined) {
  if (t.live?.status !== 'busy') {
    // Esc on an idle prompt is harmless once, but a double Esc opens the rewind menu.
    await r.reply(m.notBusy)
    return
  }
  const pid = t.live.pid
  const { via, error } = await typeInto(pid, peer, ['Escape'])
  if (error) {
    if (!peer) {
      await r.reply(m.escFailed(error))
      return
    }
    setStopFlag(t)
    await r.reply(m.escFailedFallback(error))
    return
  }
  r.react('⏹️')
  const reply = await r.reply(m.escSent(via!))
  await Bun.sleep(4000)
  if (t.live?.pid === pid && t.live.status === 'busy' && peer) {
    setStopFlag(t)
    await reply.edit(m.stillBusy)
  } else {
    await reply.edit(m.interrupted)
  }
}

/** `!end`: interrupt if busy, then type `/exit`. The channel is archived when the process goes away. */
async function endSession(t: Tracked, r: Replier, peer: Socket | undefined) {
  const pid = t.live?.pid
  if (!pid) return
  if (t.live?.status === 'busy') {
    const { error } = await typeInto(pid, peer, ['Escape'])
    if (error) {
      await r.reply(m.cantInterrupt(error))
      return
    }
    await Bun.sleep(1500)
  }
  const { via, error } = await typeInto(pid, peer, [{ text: '/exit' }, 'Enter'])
  if (error) {
    await r.reply(m.cantEnd(error))
    return
  }
  const reply = await r.reply(m.exitSent(via!))
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await Bun.sleep(1000)
    if (!tracked.has(t.sessionId)) {
      await reply.edit(m.endedCanResume).catch(() => {})
      return
    }
  }
  await reply.edit(m.exitTimeout).catch(() => {})
}

// ---- commands: !text, /slash and the console share these --------------------

const COMMANDS = ['new', 'stop', 'end', 'resume', 'migrate'] as const
type Command = (typeof COMMANDS)[number]

/** Where a command's status messages go. `reply` returns a handle to edit that message later. */
type Replier = {
  reply(text: string): Promise<{ edit(text: string): Promise<unknown> }>
  react(emoji: string): void
}

function messageReplier(msg: Message): Replier {
  return {
    reply: async text => {
      const sent = await msg.reply(text)
      return { edit: t => sent.edit(t) }
    },
    react: emoji => void msg.react(emoji).catch(() => {}),
  }
}

/** For an interaction that has already been deferred: the first reply fills the deferred one. */
function interactionReplier(i: RepliableInteraction, ephemeral = false): Replier {
  let first = true
  return {
    reply: async text => {
      if (first) {
        first = false
        await i.editReply(text)
        return { edit: t => i.editReply(t) }
      }
      const sent = await i.followUp({ content: text, ephemeral })
      return { edit: t => i.webhook.editMessage(sent, { content: t }) }
    },
    react: () => {},
  }
}

function endedByChannel(channelId: string): [string, SessionState] | undefined {
  return Object.entries(state.sessions).find(([, st]) => st.ended && st.channelId === channelId)
}

/** Run `cmd` for the session whose channel is `channelId` (`new` works anywhere). */
async function runCommand(r: Replier, channelId: string, cmd: Command, dir?: string, prompt?: string) {
  try {
    if (cmd === 'new') return await startNewSession(r, dir, prompt)
    if (cmd === 'migrate') return await migrateToForum(r)
    const t = trackedByChannel(channelId)
    if (cmd === 'resume') {
      if (t) return void (await r.reply(m.stillRunning))
      const ended = endedByChannel(channelId)
      if (!ended) return void (await r.reply(m.notSessionChannel))
      return await resumeSession(r, ...ended)
    }
    if (!t) return void (await r.reply(endedByChannel(channelId) ? m.alreadyEnded : m.notSessionChannel))
    const peer = t.live ? peers.get(t.live.pid) : undefined
    if (cmd === 'stop') return await stopSession(t, r, peer)
    return await endSession(t, r, peer)
  } catch (e: any) {
    await r.reply(m.failed(String(e?.message ?? e))).catch(() => {})
  }
}

/** English description plus a zh-TW localization; Discord shows each user their own language. */
const described = <T extends { setDescription(d: string): T; setDescriptionLocalizations(l: Record<string, string>): T }>(
  b: T,
  key: keyof typeof SLASH_DESCRIPTIONS,
) => b.setDescription(SLASH_DESCRIPTIONS[key].en).setDescriptionLocalizations({ 'zh-TW': SLASH_DESCRIPTIONS[key]['zh-TW'] })

/** A slash command choice named in English with a zh-TW localization. */
const choice = (value: string, key: keyof typeof SLASH_DESCRIPTIONS) => ({
  name: SLASH_DESCRIPTIONS[key].en,
  name_localizations: { 'zh-TW': SLASH_DESCRIPTIONS[key]['zh-TW'] },
  value,
})

/** Permission modes for /mode, in Claude Code's Shift+Tab order. Defined before SLASH_COMMANDS, which uses them at load time. */
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const
type Mode = (typeof MODES)[number]
const isMode = (s: string): s is Mode => (MODES as readonly string[]).includes(s)
const MODE_LABELS: Record<Mode, string> = {
  default: 'default',
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  bypassPermissions: 'bypass permissions',
}

/** /new; with several computers its first option picks which one. */
function newCommand() {
  const b = described(new SlashCommandBuilder().setName('new'), 'new')
  if (MACHINE) b.addStringOption(o => described(o.setName('device'), 'device').setRequired(true).setAutocomplete(true))
  return b
}

const SLASH_COMMANDS = [
  newCommand()
    .addStringOption(o => described(o.setName('dir'), 'dir').setRequired(true).setAutocomplete(true))
    .addStringOption(o => described(o.setName('prompt'), 'prompt')),
  described(new SlashCommandBuilder().setName('stop'), 'stop'),
  described(new SlashCommandBuilder().setName('end'), 'end'),
  described(new SlashCommandBuilder().setName('resume'), 'resume'),
  described(new SlashCommandBuilder().setName('migrate'), 'migrate'),
  described(new SlashCommandBuilder().setName('share'), 'share')
    .addUserOption(o => described(o.setName('user'), 'shareUser').setRequired(true))
    .addStringOption(o =>
      described(o.setName('role'), 'shareRole')
        .setRequired(true)
        .addChoices(...(['viewer', 'collab', 'full'] as const).map(v => choice(v, `role${v[0].toUpperCase()}${v.slice(1)}` as keyof typeof SLASH_DESCRIPTIONS))),
    ),
  described(new SlashCommandBuilder().setName('unshare'), 'unshare').addUserOption(o => described(o.setName('user'), 'unshareUser').setRequired(true)),
  described(new SlashCommandBuilder().setName('members'), 'members'),
  described(new SlashCommandBuilder().setName('sync'), 'sync').addStringOption(o =>
    described(o.setName('state'), 'syncState').setRequired(true).addChoices(choice('off', 'syncOff'), choice('on', 'syncOn')),
  ),
  described(new SlashCommandBuilder().setName('mode'), 'mode').addStringOption(o =>
    described(o.setName('mode'), 'modeName')
      .setRequired(true)
      .addChoices(...MODES.map(v => ({ name: MODE_LABELS[v], value: v }))),
  ),
  described(new SlashCommandBuilder().setName('model'), 'model').addStringOption(o =>
    described(o.setName('name'), 'modelName').setRequired(true).setAutocomplete(true),
  ),
]

/** Autocomplete for /new: subfolders of what's typed so far, then recently used folders. */
function dirSuggestions(typed: string): { name: string; value: string }[] {
  const out = new Set<string>()
  const expanded = expandHome(typed)
  // Either separator, so Windows paths (C:\Users\…) complete too.
  if (/[\\/]/.test(typed)) {
    const endsWithSep = /[\\/]$/.test(expanded)
    const base = endsWithSep ? expanded : dirname(expanded)
    const prefix = endsWithSep ? '' : basename(expanded)
    try {
      for (const e of readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(prefix.toLowerCase())) out.add(join(base, e.name))
      }
    } catch {}
  }
  const recent = Object.values(state.sessions)
    .sort((a, b) => (b.endedAt ?? Number.MAX_SAFE_INTEGER) - (a.endedAt ?? Number.MAX_SAFE_INTEGER))
    .map(st => st.cwd)
  for (const cwd of recent) if (cwd.toLowerCase().includes(expanded.toLowerCase())) out.add(cwd)
  return [...out]
    .filter(d => d.length <= 100)
    .slice(0, 25)
    .map(d => ({ name: d, value: d }))
}

// ---- console channel: every session at a glance -------------------------------

let consoleRendered = ''
let consoleEditedAt = 0

const statusIcon = (status?: string) => (status === 'busy' ? m.busy : status === 'idle' ? m.idle : m.waiting)
const channelLabel = (st: SessionState) => {
  const name = guild.channels.cache.get(st.channelId)?.name
  return st.archiveThreadId === st.channelId ? '🗂️' : name ? `#${name}` : m.channelDeleted
}

/** Coarse on purpose: the console is re-rendered whenever this text changes. */
function ago(ms: number | undefined): string {
  if (!ms) return ''
  const h = Math.floor((Date.now() - ms) / 3_600_000)
  return h < 1 ? m.withinHour : h < 24 ? m.hoursAgo(h) : m.daysAgo(Math.floor(h / 24))
}

/** What a session was about: its title, else the last thing the user said. */
const sessionTopic = (st: SessionState) => st.title || (st.lastPrompt ? `「${st.lastPrompt}」` : '')

function sessionOption(sid: string, st: SessionState) {
  const label = [channelLabel(st), sessionTopic(st)].filter(Boolean).join(' · ')
  const description = [st.ended ? m.endedAgo(ago(st.endedAt)) : '', st.cwd].filter(Boolean).join(' · ')
  return { label: clip(label, 100), description: clip(description, 100), value: sid }
}

function recentEnded(n: number): [string, SessionState][] {
  return Object.entries(state.sessions)
    // No transcript = nothing was ever said, so there is nothing to resume.
    .filter(([sid, st]) => st.ended && st.transcript && !tracked.has(sid))
    .sort(([, a], [, b]) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, n)
}

function consoleView() {
  const live = [...tracked.values()].filter(t => t.live)
  const ended = recentEnded(25)
  const lines = ['## 🖥️ Claude Sessions', ...(state.pausedAll ? [m.allPausedBanner] : []), m.running]
  if (!live.length) lines.push(m.none)
  for (const t of live) {
    const topic = sessionTopic(t.st)
    lines.push(`${isPaused(t.st) ? m.pausedTag + ' ' : ''}${statusIcon(t.live!.status)} · <#${t.st.channelId}> · \`${t.st.cwd}\`${topic ? ` · ${clip(topic, 60)}` : ''}`)
  }
  lines.push('', m.recentlyEnded)
  if (!ended.length) lines.push(m.none)
  for (const [, st] of ended.slice(0, 10)) {
    const topic = sessionTopic(st)
    lines.push(`⚫ <#${st.channelId}> · ${ago(st.endedAt)} · \`${st.cwd}\`${topic ? ` · ${clip(topic, 60)}` : ''}`)
  }

  const menu = (id: string, placeholder: string, items: [string, SessionState][]) =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(id)
        .setPlaceholder(placeholder)
        .addOptions(items.slice(0, 25).map(([sid, st]) => sessionOption(sid, st))),
    )
  const busy = live.filter(t => t.live!.status === 'busy').map(t => [t.sessionId, t.st] as [string, SessionState])
  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = []
  if (busy.length) components.push(menu('console:stop', m.stopMenu, busy))
  if (live.length) components.push(menu('console:end', m.endMenu, live.map(t => [t.sessionId, t.st])))
  if (ended.length) components.push(menu('console:resume', m.resumeMenu, ended))
  // One session at a time; while everything is paused only "resume all" makes sense.
  if (live.length && !state.pausedAll) {
    components.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('console:pause')
          .setPlaceholder(m.pauseMenu)
          .addOptions(
            live.slice(0, 25).map(t => {
              const o = sessionOption(t.sessionId, t.st)
              return { ...o, label: clip(`${t.st.paused ? '▶️' : '⏸️'} ${o.label}`, 100) }
            }),
          ),
      ),
    )
  }
  const buttons = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId('console:new').setLabel(m.newSession).setEmoji('🆕').setStyle(ButtonStyle.Primary),
    state.pausedAll
      ? new ButtonBuilder().setCustomId('console:resumeall').setLabel(m.resumeAll).setEmoji('▶️').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId('console:pauseall').setLabel(m.pauseAll).setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
  )
  const legacy = forumAvailable() ? legacyArchived().length : 0
  if (legacy) {
    buttons.addComponents(
      new ButtonBuilder().setCustomId('console:migrate').setLabel(m.migrateButton(legacy)).setEmoji('🗂️').setStyle(ButtonStyle.Secondary),
    )
  }
  components.push(buttons)
  return { content: clip(lines.join('\n'), 2000), components }
}

async function consoleChannel(): Promise<TextChannel | undefined> {
  if (!CONSOLE_NAME) return undefined
  const cached = state.consoleChannelId ? guild.channels.cache.get(state.consoleChannelId) : undefined
  if (cached?.type === ChannelType.GuildText) {
    // Multi-machine mode switched on: give the console this computer's name.
    if (MACHINE && cached.name !== discordName(CONSOLE_NAME)) await cached.setName(CONSOLE_NAME).catch(() => {})
    return cached
  }
  const ch = await guild.channels.create({
    name: CONSOLE_NAME,
    type: ChannelType.GuildText,
    parent: state.categoryId,
    position: 0,
    topic: m.consoleTopic,
  })
  state.consoleChannelId = ch.id
  state.consoleMessageId = undefined
  stateDirty = true
  return ch
}

/** Keep the console's status message current; edits are skipped when nothing changed and throttled. */
async function updateConsole() {
  const ch = await consoleChannel()
  if (!ch) return
  const view = consoleView()
  const rendered = JSON.stringify({ c: view.content, k: view.components.map(c => c.toJSON()) })
  if (rendered === consoleRendered && state.consoleMessageId) return
  if (Date.now() - consoleEditedAt < 3000) return
  consoleEditedAt = Date.now()
  if (state.consoleMessageId) {
    const ok = await ch.messages
      .edit(state.consoleMessageId, { ...view, allowedMentions: { parse: [] } })
      .then(() => true)
      .catch(() => false)
    if (ok) {
      consoleRendered = rendered
      return
    }
  }
  // First run, or someone deleted the message: post a fresh one.
  const sent = await ch.send({ ...view, allowedMentions: { parse: [] } })
  state.consoleMessageId = sent.id
  stateDirty = true
  consoleRendered = rendered
}

async function handleConsoleInteraction(i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
  if (!isOwner(i.user.id)) {
    await i.reply({ content: m.notAuthorized, ephemeral: true })
    return
  }
  if (i.isButton() && i.customId === 'console:new') {
    const dir = new TextInputBuilder().setCustomId('dir').setLabel(m.folder).setStyle(TextInputStyle.Short).setRequired(true)
    const last = recentEnded(1)[0]?.[1].cwd ?? [...tracked.values()][0]?.st.cwd
    if (last) dir.setPlaceholder(clip(last, 100))
    const prompt = new TextInputBuilder().setCustomId('prompt').setLabel(m.firstMessage).setStyle(TextInputStyle.Paragraph).setRequired(false)
    await i.showModal(
      new ModalBuilder()
        .setCustomId('console:newmodal')
        .setTitle(m.newSession)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(dir),
          new ActionRowBuilder<TextInputBuilder>().addComponents(prompt),
        ),
    )
    return
  }
  await i.deferReply({ ephemeral: true })
  const r = interactionReplier(i, true)
  if (i.isButton() && i.customId === 'console:migrate') {
    await runCommand(r, '', 'migrate')
    return
  }
  if (i.isButton() && (i.customId === 'console:pauseall' || i.customId === 'console:resumeall')) {
    await setAllPaused(i.customId === 'console:pauseall', i.user.username)
    await r.reply(state.pausedAll ? m.allPaused : m.allResumed)
    return
  }
  if (i.isStringSelectMenu() && i.customId === 'console:pause') {
    const t = tracked.get(i.values[0])
    if (!t) return void (await r.reply(m.sessionNotFound))
    await setSessionPaused(t, !t.st.paused, i.user.username)
    await r.reply(t.st.paused ? m.sessionPaused(t.st.channelId) : m.sessionResumed(t.st.channelId))
    consoleRendered = ''
    return
  }
  if (i.isModalSubmit()) {
    await runCommand(r, '', 'new', i.fields.getTextInputValue('dir').trim(), i.fields.getTextInputValue('prompt').trim() || undefined)
    return
  }
  if (!i.isStringSelectMenu()) return
  const action = i.customId.slice('console:'.length) as Command
  const st = state.sessions[i.values[0]]
  if (!st || !COMMANDS.includes(action)) return void (await r.reply(m.sessionNotFound))
  await runCommand(r, st.channelId, action)
  consoleRendered = '' // Reset the menu's selection on the next tick.
}

// ---- cleanup of old ended channels ----------------------------------------------

let cleanedAt = 0

async function cleanupEnded() {
  if (cfg.deleteEndedAfterDays <= 0 || Date.now() - cleanedAt < 10 * 60_000) return
  cleanedAt = Date.now()
  const cutoff = Date.now() - cfg.deleteEndedAfterDays * 86_400_000
  for (const [sid, st] of Object.entries(state.sessions)) {
    if (!st.ended || !st.endedAt || st.endedAt > cutoff || tracked.has(sid) || creating.has(sid)) continue
    const ch = await guild.channels.fetch(st.channelId).catch(() => null)
    await ch?.delete('discord-sync: session ended long ago').catch(e => log(`delete #${ch.name} failed:`, e?.message))
    delete state.sessions[sid]
    stateDirty = true
    log(`deleted channel for ${sid} (ended ${new Date(st.endedAt).toISOString()})`)
  }
}

// ---- sharing: per-session members and private channels ----------------------

/** Set at startup: without Manage Roles, channels stay visible to everyone and /share is off. */
let canManageRoles = false

const OWNER_ALLOW = { ViewChannel: true, ReadMessageHistory: true, SendMessages: true }
/** The bot must keep seeing and managing channels after @everyone is shut out. */
const BOT_ALLOW = {
  ViewChannel: true,
  ReadMessageHistory: true,
  SendMessages: true,
  SendMessagesInThreads: true,
  CreatePublicThreads: true,
  ManageChannels: true,
  ManageRoles: true,
  ManageThreads: true,
  AttachFiles: true,
  AddReactions: true,
  EmbedLinks: true,
}
function memberPerms(role: Role) {
  const act = role !== 'viewer'
  return { ViewChannel: true, ReadMessageHistory: true, SendMessages: act, SendMessagesInThreads: act, AddReactions: act, AttachFiles: act }
}

function sessionByChannel(channelId: string): SessionState | undefined {
  return trackedByChannel(channelId)?.st ?? endedByChannel(channelId)?.[1]
}

/** Give a session channel its members' overwrites (after creating or recreating it). */
async function applyMembers(ch: TextChannel, st: SessionState) {
  if (!canManageRoles) return
  for (const [id, role] of Object.entries(st.members ?? {})) {
    await ch.permissionOverwrites.edit(id, memberPerms(role)).catch(e => log(`member overwrite for ${id} failed:`, e?.message))
  }
}

/**
 * Make our categories private: only the bot and the owners can see them, and
 * channels in them follow. Channels created before this (or with members) are
 * re-synced to the category and get their members' overwrites back.
 */
async function lockDown() {
  canManageRoles = !!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)
  if (!canManageRoles) {
    log('bot lacks "Manage Roles": session channels stay visible to everyone and /share is disabled')
    return
  }
  for (const id of [state.categoryId, state.archiveCategoryId]) {
    const cat = id ? guild.channels.cache.get(id) : undefined
    if (cat?.type !== ChannelType.GuildCategory) continue
    try {
      // Bot first, or denying @everyone could lock the bot out of its own category.
      await cat.permissionOverwrites.edit(client.user!.id, BOT_ALLOW)
      for (const owner of cfg.allowFrom) await cat.permissionOverwrites.edit(owner, OWNER_ALLOW)
      await cat.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false })
      for (const child of cat.children.cache.values()) {
        if (child.permissionsLocked) continue
        await child.lockPermissions()
        const st = child.type === ChannelType.GuildText ? sessionByChannel(child.id) : undefined
        if (st && child.type === ChannelType.GuildText) await applyMembers(child, st)
      }
    } catch (e: any) {
      log(`making ${cat.name} private failed:`, e?.message ?? e)
    }
  }
}

const roleName = (r: Role) => (r === 'viewer' ? m.roleViewer : r === 'collab' ? m.roleCollab : m.roleFull)

async function share(r: Replier, channelId: string, userId: string, role: Role | undefined) {
  const st = sessionByChannel(channelId)
  const ch = st && guild.channels.cache.get(st.channelId)
  if (!st || ch?.type !== ChannelType.GuildText) return void (await r.reply(m.notSessionChannel))
  if (!canManageRoles) return void (await r.reply(m.needManageRoles))
  if (isOwner(userId)) return void (await r.reply(m.alreadyOwner))
  if (role) {
    await ch.permissionOverwrites.edit(userId, memberPerms(role))
    st.members = { ...st.members, [userId]: role }
    await r.reply(m.shared(userId, roleName(role)))
  } else {
    await ch.permissionOverwrites.delete(userId).catch(() => {})
    if (st.members) delete st.members[userId]
    await r.reply(m.unshared(userId))
  }
  stateDirty = true
}

function memberList(st: SessionState): string {
  const lines = cfg.allowFrom.map(id => `👑 <@${id}> · ${m.roleOwner}`)
  for (const [id, role] of Object.entries(st.members ?? {})) lines.push(`${role === 'viewer' ? '👀' : role === 'collab' ? '💬' : '🔑'} <@${id}> · ${roleName(role)}`)
  return `${m.membersTitle}\n${lines.join('\n')}`
}

/** How a person is described to Claude. */
function roleTag(userId: string, st: SessionState): string {
  const a = accessOf(userId, st)
  return a === 'owner' ? 'owner' : a === 'full' ? 'collaborator (full)' : a === 'collab' ? 'collaborator' : a === 'viewer' ? 'viewer' : 'no access'
}

// ---- meetings ---------------------------------------------------------------------

const MEETING_IDLE_MS = 30 * 60_000
const MEETING_MAX_MESSAGES = 1000

async function startMeeting(t: Tracked, msg: Message, people: import('discord.js').User[]) {
  t.st.meeting = { startMessageId: msg.id, startedAt: Date.now(), lastAt: Date.now() }
  stateDirty = true
  // The channel is private: point out anyone who can't see it.
  const locked = people.filter(u => !can(u.id, t.st, 'view')).map(u => u.username)
  await msg.reply({ content: [m.meetingStarted, locked.length ? m.meetingNoAccess(locked.join(', ')) : ''].filter(Boolean).join('\n'), allowedMentions: { parse: [] } }).catch(() => {})
}

/** Every human message from the meeting's first message up to and including `last`, oldest first. */
async function meetingMessages(ch: TextChannel, startId: string, last: Message): Promise<Message[]> {
  const out: Message[] = []
  let after = (BigInt(startId) - 1n).toString()
  while (out.length < MEETING_MAX_MESSAGES) {
    const batch = [...(await ch.messages.fetch({ after, limit: 100 })).values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    if (!batch.length) break
    for (const msg of batch) if (BigInt(msg.id) <= BigInt(last.id) && !msg.author.bot) out.push(msg)
    after = batch[batch.length - 1].id
    if (batch.length < 100 || BigInt(after) >= BigInt(last.id)) break
  }
  return out
}

/** Write the discussion to a Markdown file and send it to Claude with the closing message as the conclusion. */
async function endMeeting(t: Tracked, msg: Message, peer: Socket) {
  const meeting = t.st.meeting!
  if (isPaused(t.st)) return void msg.reply(m.pausedReply).catch(() => {})
  const ch = await channelOf(t)
  if (!ch) return
  const msgs = await meetingMessages(ch, meeting.startMessageId, msg)
  const botMention = new RegExp(`<@!?${client.user!.id}>`, 'g')
  const people = [...new Map(msgs.map(x => [x.author.id, x.author])).values()]
  const time = (d: Date) => d.toISOString().slice(11, 16)
  // Attachments are saved locally like a normal message's, so Claude can open them.
  const saved = new Map<string, string | undefined>()
  for (const x of msgs) for (const a of x.attachments.values()) saved.set(a.id, await downloadAttachment(a))
  const notes = [
    `# Discussion in #${ch.name}`,
    `Participants: ${people.map(u => `${u.username} (${roleTag(u.id, t.st)})`).join(', ')}`,
    `${new Date(meeting.startedAt).toISOString()} – ${msg.createdAt.toISOString()} (UTC)`,
    '',
    ...msgs.flatMap(x => {
      const files = [...x.attachments.values()]
        .map(a => `\n  [attachment: ${a.name} ${saved.get(a.id) ? `saved at ${saved.get(a.id)}` : `(not downloaded: over 25 MB or failed) ${a.url}`}]`)
        .join('')
      // Drop the bot's tag before mentions are turned into @names.
      const text = cleanContent(x.content.replace(botMention, ''), ch)
      // A bare bot tag leaves nothing to record.
      if (!text.trim() && !files) return []
      return `**${x.author.username}** (${roleTag(x.author.id, t.st)}) ${time(x.createdAt)}: ${text.trim()}${files}`
    }),
  ].join('\n')
  mkdirSync(INBOX_DIR, { recursive: true })
  const file = join(INBOX_DIR, `meeting-${Date.now()}.md`)
  writeFileSync(file, notes)
  const conclusion = msg.content.replace(botMention, '').trim()
  ipcSend(peer, {
    t: 'message',
    content: conclusion || '(no conclusion given)',
    meta: {
      message_id: msg.id,
      user: msg.author.username,
      ...(isOwner(msg.author.id) ? {} : { role: roleTag(msg.author.id, t.st) }),
      ts: msg.createdAt.toISOString(),
      meeting: `${msgs.length} messages from ${people.map(u => u.username).join(', ')}`,
      attachments: [file, ...[...saved.values()].filter((p): p is string => !!p)].join('; '),
    },
  })
  t.st.meeting = undefined
  t.st.lastPrompt = (conclusion || m.meetingLastPrompt).replace(/\s+/g, ' ').slice(0, 200)
  stateDirty = true
  void msg.react('📨').catch(() => {})
  await msg.reply({ content: m.meetingEnded(msgs.length), allowedMentions: { parse: [] } }).catch(() => {})
}

/** Nudge once when a meeting has gone quiet; nothing is sent to Claude on its own. */
function remindIdleMeeting(t: Tracked) {
  const mt = t.st.meeting
  if (!mt || mt.reminded || Date.now() - mt.lastAt < MEETING_IDLE_MS) return
  mt.reminded = true
  stateDirty = true
  void post(t, [m.meetingIdle])
}

// ---- pausing --------------------------------------------------------------------

async function setSessionPaused(t: Tracked, paused: boolean, by: string) {
  if (!!t.st.paused === paused) return
  t.st.paused = paused
  stateDirty = true
  if (state.pausedAll) return // still paused overall; nothing visibly changes
  await announcePause(t, paused, by)
}

async function setAllPaused(paused: boolean, by: string) {
  if (!!state.pausedAll === paused) return
  state.pausedAll = paused
  stateDirty = true
  for (const t of tracked.values()) if (t.live && !t.st.paused) await announcePause(t, paused, by)
}

async function announcePause(t: Tracked, paused: boolean, by: string) {
  if (paused) {
    t.st.pausedSkipped = 0
    await post(t, [m.syncPaused(by)])
  } else {
    const skipped = t.st.pausedSkipped ?? 0
    t.st.pausedSkipped = 0
    await post(t, [m.syncResumed(by, skipped)])
  }
}

/** /sync on|off: in a session channel for that session, anywhere else for every session. */
async function setSync(r: Replier, channelId: string, on: boolean, by: string) {
  const t = trackedByChannel(channelId)
  if (t) {
    await setSessionPaused(t, !on, by)
    await r.reply(on ? m.sessionResumed(t.st.channelId) : m.sessionPaused(t.st.channelId))
  } else {
    await setAllPaused(!on, by)
    await r.reply(on ? m.allResumed : m.allPaused)
  }
}

// ---- /share, /unshare, /members, /sync -------------------------------------------

const SESSION_COMMANDS = ['share', 'unshare', 'members', 'sync', 'model', 'mode'] as const

async function handleSessionCommand(i: import('discord.js').ChatInputCommandInteraction) {
  const st = sessionByChannel(i.channelId)
  const need: Need = i.commandName === 'members' ? 'view' : 'owner'
  if (!can(i.user.id, st, need) && !(i.commandName === 'sync' && isOwner(i.user.id))) {
    await i.reply({ content: m.notAuthorized, ephemeral: true })
    return
  }
  if (i.commandName === 'members') {
    if (!st) return void (await i.reply({ content: m.notSessionChannel, ephemeral: true }))
    await i.reply({ content: memberList(st), ephemeral: true, allowedMentions: { parse: [] } })
    return
  }
  await i.deferReply()
  const r = interactionReplier(i)
  if (i.commandName === 'sync') return setSync(r, i.channelId, i.options.getString('state') === 'on', i.user.username)
  if (i.commandName === 'mode') return setMode(r, i.channelId, i.options.getString('mode', true) as Mode)
  if (i.commandName === 'model') return setModel(r, i.channelId, i.options.getString('name', true).trim())
  const user = i.options.getUser('user', true)
  if (user.bot) return void (await r.reply(m.cantShareWithBot))
  await share(r, i.channelId, user.id, i.commandName === 'share' ? (i.options.getString('role', true) as Role) : undefined)
}

// ---- /mode ---------------------------------------------------------------------

/**
 * The mode shown in Claude Code's footer ("⏵⏵ auto mode on (shift+tab to cycle)").
 * The transcript only records a mode change with the next message, so the
 * screen is the only place to read it right after Shift+Tab.
 */
function modeOnScreen(screen: string): Mode {
  const footer = screen.split('\n').filter(l => l.trim()).slice(-4).join('\n').toLowerCase()
  if (footer.includes('bypass permissions on')) return 'bypassPermissions'
  if (footer.includes('accept edits on')) return 'acceptEdits'
  if (footer.includes('plan mode on')) return 'plan'
  if (footer.includes('auto mode on')) return 'auto'
  return 'default'
}

/** The session's screen: from tmux, or its console on Windows. Undefined for a plain terminal. */
async function screenOf(pid: number): Promise<string | undefined> {
  const tmux = tmuxPaneOf(pid)
  if (tmux) return (await run('tmux', ['-S', tmux.socket, 'capture-pane', '-p', '-t', tmux.pane]).catch(() => undefined))?.stdout
  if (IS_WIN) return (await winConsole('screen', pid)).text
  return undefined
}

/** Press Shift+Tab until the footer shows `target`, giving up after a full cycle. */
async function setMode(r: Replier, channelId: string, target: Mode) {
  const t = trackedByChannel(channelId)
  if (!t?.live) return void (await r.reply(t || endedByChannel(channelId) ? m.alreadyEnded : m.notSessionChannel))
  const pid = t.live.pid
  const peer = peers.get(pid)
  let screen = await screenOf(pid)
  if (screen === undefined) return void (await r.reply(m.modeNeedsScreen))
  const start = modeOnScreen(screen)
  if (start === target) return void (await r.reply(m.modeAlready(MODE_LABELS[target])))
  // default → accept edits → plan → auto / bypass (when enabled) → default: at most 5 steps.
  for (let i = 0; i < 6; i++) {
    const { error } = await typeInto(pid, peer, ['BackTab'])
    if (error) return void (await r.reply(m.cantType(error)))
    await Bun.sleep(500)
    screen = await screenOf(pid)
    if (screen === undefined) break
    const now = modeOnScreen(screen)
    if (now === target) return void (await r.reply(m.modeSet(MODE_LABELS[target])))
    if (now === start) return void (await r.reply(m.modeUnavailable(MODE_LABELS[target], MODE_LABELS[start])))
  }
  await r.reply(m.modeUnknown(MODE_LABELS[target]))
}

// ---- /model --------------------------------------------------------------------

/** Suggestions for /model; anything matching MODEL_NAME_RE (a full model ID too) is accepted. */
const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'default']
/** Typed into the terminal, so nothing that could end the line or press a key. */
const MODEL_NAME_RE = /^[\w.:\[\]-]{1,80}$/

/** Type `/model <name>` into the idle session, then report what Claude Code answered. */
async function setModel(r: Replier, channelId: string, name: string) {
  const t = trackedByChannel(channelId)
  if (!t?.live) return void (await r.reply(t || endedByChannel(channelId) ? m.alreadyEnded : m.notSessionChannel))
  if (!MODEL_NAME_RE.test(name)) return void (await r.reply(m.badModelName))
  // While Claude works, typed text would sit in the input box until the turn ends.
  if (t.live.status === 'busy') return void (await r.reply(m.busyTryLater))
  const transcript = t.st.transcript
  const offset = transcript ? (statSync(transcript, { throwIfNoEntry: false })?.size ?? 0) : 0
  const { via, error } = await typeInto(t.live.pid, peers.get(t.live.pid), [{ text: `/model ${name}` }, 'Enter'])
  if (error) return void (await r.reply(m.cantType(error)))
  const reply = await r.reply(m.modelSent(name, via!))
  if (!transcript) return
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await Bun.sleep(1000)
    const out = commandOutputSince(transcript, offset)
    if (out !== undefined) return void (await reply.edit(m.modelResult(out)).catch(() => {}))
  }
}

/** The first local command output (`<local-command-stdout>`) written to the transcript after `offset`. */
function commandOutputSince(file: string, offset: number): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = statSync(file).size
    if (size <= offset) return undefined
    const buf = Buffer.alloc(Math.min(size - offset, 1024 * 1024))
    readSync(fd, buf, 0, buf.length, offset)
    for (const line of buf.toString('utf8').split('\n')) {
      let rec: any
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const content = rec?.message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : ''
      const match = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(text)
      if (match) return match[1].replace(/\x1b\[[0-9;]*m/g, '').trim()
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  return undefined
}

// ---- several computers, one bot (experimental) --------------------------------
//
// Every computer's daemon receives every message and interaction. Each one keeps
// an entry (one message) in a shared devices channel, refreshed every minute, so
// all of them know who is online. Then, without talking to each other:
// - a computer handles what happens in its own channels;
// - /new goes to the computer it names;
// - the first online computer by name (the "leader") answers what belongs to
//   nobody: the device list, an offline target, commands used elsewhere.

const DEVICES_CHANNEL = 'claude-devices'
const BEAT_MS = 60_000
const DEVICES_REFRESH_MS = 20_000
const OFFLINE_AFTER_MS = 150_000
const DEVICE_TAG_RE = /cds-device name=(\S+) category=(\d*) console=(\d*)/

type Device = { name: string; seen: number; offline: boolean; categoryId?: string; consoleId?: string; mine: boolean }
let devices: Device[] = []
let lastBeat = 0
let warnedDuplicate = false

/** Discord's form of a text channel name. */
const discordName = (name: string) => name.toLowerCase().replace(/\s+/g, '-')

const parentOf = (channelId: string): string | undefined => (guild.channels.cache.get(channelId) as { parentId?: string | null } | undefined)?.parentId ?? undefined

/** The oldest channel by that name, so two computers that created one at once still meet in the same one. */
async function devicesChannel(): Promise<TextChannel> {
  const found = guild.channels.cache
    .filter((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === DEVICES_CHANNEL)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .first()
  const ch =
    found ??
    (await guild.channels.create({
      name: DEVICES_CHANNEL,
      type: ChannelType.GuildText,
      topic: m.devicesTopic,
      permissionOverwrites: canManageRoles
        ? [
            { id: client.user!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            ...cfg.allowFrom.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })),
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          ]
        : undefined,
    }))
  if (state.devicesChannelId !== ch.id) {
    state.devicesChannelId = ch.id
    state.deviceMessageId = undefined
    stateDirty = true
  }
  return ch
}

/** Write this computer's entry: name, last seen, and its category and console so others can tell its channels apart. */
async function heartbeat(offline = false) {
  const ch = await devicesChannel()
  const content =
    `${offline ? '🔴' : '🟢'} **${MACHINE}** · <t:${Math.floor(Date.now() / 1000)}:R>\n` +
    `-# cds-device name=${encodeURIComponent(MACHINE!)} category=${state.categoryId ?? ''} console=${state.consoleChannelId ?? ''}`
  lastBeat = Date.now()
  if (state.deviceMessageId) {
    const edited = await ch.messages.edit(state.deviceMessageId, { content }).then(
      () => true,
      () => false,
    )
    if (edited) return
  }
  const sent = await ch.send({ content, flags: MessageFlags.SuppressNotifications, allowedMentions: { parse: [] } })
  state.deviceMessageId = sent.id
  stateDirty = true
}

/** Re-read every computer's entry. "Last seen" is Discord's edit time, so clocks don't need to agree. */
async function refreshDevices() {
  const ch = await devicesChannel()
  const byName = new Map<string, Device>()
  for (const msg of (await ch.messages.fetch({ limit: 50 })).values()) {
    if (msg.author.id !== client.user!.id) continue
    const match = DEVICE_TAG_RE.exec(msg.content)
    if (!match) continue
    const mine = msg.id === state.deviceMessageId
    const d: Device = {
      name: decodeURIComponent(match[1]),
      seen: mine ? Date.now() : (msg.editedTimestamp ?? msg.createdTimestamp),
      offline: !mine && msg.content.startsWith('🔴'),
      categoryId: match[2] || undefined,
      consoleId: match[3] || undefined,
      mine,
    }
    if (d.name === MACHINE && !mine && isOnline(d) && !warnedDuplicate) {
      warnedDuplicate = true
      log(`another computer is also called "${MACHINE}"; give each one its own "machine" name`)
    }
    const prev = byName.get(d.name)
    if (!prev || d.mine || (!prev.mine && d.seen > prev.seen)) byName.set(d.name, d)
  }
  devices = [...byName.values()]
}

async function machineTick() {
  if (Date.now() - lastBeat >= BEAT_MS) await heartbeat()
  await refreshDevices()
}

const isOnline = (d: Device) => d.mine || (!d.offline && Date.now() - d.seen < OFFLINE_AFTER_MS)
function onlineDevices(): Device[] {
  const list = devices.filter(isOnline)
  if (!list.some(d => d.mine)) list.push({ name: MACHINE!, seen: Date.now(), offline: false, mine: true })
  return list.sort((a, b) => a.name.localeCompare(b.name))
}
const onlineNames = () => onlineDevices().map(d => d.name)
const isLeader = () => onlineDevices()[0]?.name === MACHINE

/** This computer's channel: one of its sessions (live or archived), its console, or anything in its category. */
function ownsChannel(channelId: string, parentId: string | undefined): boolean {
  if (!MACHINE) return true
  return !!sessionByChannel(channelId) || channelId === state.consoleChannelId || (!!parentId && parentId === state.categoryId)
}

/** Which computer a channel belongs to, as far as the devices channel tells. */
function channelOwner(channelId: string): string | undefined {
  const parentId = parentOf(channelId)
  if (ownsChannel(channelId, parentId)) return MACHINE
  return devices.find(d => !d.mine && (d.consoleId === channelId || (!!parentId && d.categoryId === parentId)))?.name
}

/**
 * Belongs to no computer for sure. Threads and the shared archive are excluded:
 * an archived session's post belongs to whichever computer ran it, and only
 * that one knows.
 */
function isNeutral(channelId: string): boolean {
  const ch = guild.channels.cache.get(channelId)
  if (!ch || ch.isThread() || channelOwner(channelId)) return false
  const parentId = parentOf(channelId)
  return channelId !== state.archiveForumId && (!parentId || parentId !== state.archiveCategoryId)
}

function deviceChoices(typed: string, here: string | undefined): { name: string; value: string }[] {
  const online = new Set(onlineNames())
  return devices
    .map(d => d.name)
    .concat(online.has(MACHINE!) ? [] : [MACHINE!])
    .filter((n, i, all) => all.indexOf(n) === i && n.toLowerCase().includes(typed.toLowerCase()))
    // The computer whose channel this is first, then online ones.
    .sort((a, b) => Number(b === here) - Number(a === here) || Number(online.has(b)) - Number(online.has(a)) || a.localeCompare(b))
    .slice(0, 25)
    .map(n => ({ name: clip(online.has(n) ? `🟢 ${n}` : m.deviceOfflineChoice(n), 100), value: n }))
}

/** Whether this computer should handle `i`. Answers for the leader what belongs to nobody. */
async function routeHere(i: Interaction): Promise<boolean> {
  const channelId = i.channelId ?? ''
  if ((i.isAutocomplete() || i.isChatInputCommand()) && i.commandName === 'new') {
    if (i.isAutocomplete() && i.options.getFocused(true).name === 'device') {
      if (isLeader()) await i.respond(deviceChoices(String(i.options.getFocused()), channelOwner(channelId))).catch(() => {})
      return false
    }
    const device = (i.isAutocomplete() ? String(i.options.get('device')?.value ?? '') : (i.options.getString('device') ?? '')).trim()
    const target = device || channelOwner(channelId)
    if (target === MACHINE) return true
    if (!isLeader() || (target && onlineNames().includes(target))) return false
    const text = target ? m.deviceOffline(target, onlineNames()) : m.pickDevice
    if (i.isAutocomplete()) await i.respond([{ name: clip(text, 100), value: '-' }]).catch(() => {})
    else await i.reply({ content: text, ephemeral: true }).catch(() => {})
    return false
  }
  if (ownsChannel(channelId, parentOf(channelId))) return true
  if (i.isRepliable() && isNeutral(channelId) && isLeader()) await i.reply({ content: m.whichDevice(onlineNames()), ephemeral: true }).catch(() => {})
  return false
}

// ---- channel-server connections -------------------------------------------

function trackedByPid(pid: number): Tracked | undefined {
  for (const t of tracked.values()) if (t.live?.pid === pid) return t
  return undefined
}

async function handlePeer(sock: Socket, msg: ClientMsg, self: { pid?: number }) {
  if (msg.t === 'ask') {
    await startAsk(sock, msg.sessionId, msg.questions)
    return
  }
  if (msg.t === 'plan') {
    await startPlan(sock, msg.sessionId, msg.plan)
    return
  }
  if (msg.t === 'pause') {
    const t = msg.pid ? trackedByPid(msg.pid) : undefined
    if (t) {
      await setSessionPaused(t, msg.paused, m.pausedLocal)
      ipcSend(sock, { t: 'pause_result', text: msg.paused ? m.localSessionPaused : m.localSessionResumed })
    } else {
      await setAllPaused(msg.paused, m.pausedLocal)
      ipcSend(sock, { t: 'pause_result', text: msg.paused ? m.allPaused : m.allResumed })
    }
    return
  }
  if (msg.t === 'type_result') {
    interruptWaiters.get(sock)?.(msg)
    return
  }
  if (msg.t === 'hello') {
    self.pid = msg.claudePid
    peers.get(msg.claudePid)?.destroy()
    peers.set(msg.claudePid, sock)
    if (msg.tmux) peerTmux.set(msg.claudePid, msg.tmux)
    else peerTmux.delete(msg.claudePid)
    log(`channel server connected for pid ${msg.claudePid}`)
    const t = trackedByPid(msg.claudePid)
    if (t) await post(t, [m.channelConnected])
    return
  }
  const t = self.pid ? trackedByPid(self.pid) : undefined
  if (msg.t === 'permission_request') {
    // Paused: the prompt is only answered in the terminal.
    if (!t || isPaused(t.st)) return
    const ch = await channelOf(t)
    if (!ch) return
    let preview = msg.input_preview
    try {
      preview = JSON.stringify(JSON.parse(preview), null, 2)
    } catch {}
    const body = chunk(
      [
        m.permissionNeeded(msg.tool_name),
        msg.description,
        '```json\n' + preview.slice(0, 1200) + '\n```',
        m.permissionReplyHint(msg.request_id),
      ].join('\n'),
    )[0]
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${self.pid}:${msg.request_id}`).setLabel(m.allow).setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${self.pid}:${msg.request_id}`).setLabel(m.deny).setEmoji('❌').setStyle(ButtonStyle.Danger),
    )
    const who = audience(t.st, 'approve')
    await enqueue(ch.id, () =>
      ch.send({ content: `${mentionsOf(who)}\n${body}`.slice(0, 2000), components: [row], allowedMentions: { users: who } }),
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
  // Named pipes (Windows) vanish with the process; a stale Unix socket file has to be removed.
  if (!IS_WIN) rmSync(SOCKET_PATH, { force: true })
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
  server.listen(SOCKET_PATH, () => {
    if (!IS_WIN) chmodSync(SOCKET_PATH, 0o600)
  })
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
  if (MACHINE && state.categoryId && guild.channels.cache.get(state.categoryId)?.name !== CATEGORY_NAME) {
    // Multi-machine mode switched on: move this computer's channels to its own category.
    state.categoryId = await ensureCategory(CATEGORY_NAME, undefined)
    for (const id of [state.consoleChannelId, ...Object.values(state.sessions).filter(st => !st.ended).map(st => st.channelId)]) {
      const ch = id ? guild.channels.cache.get(id) : undefined
      if (ch?.type === ChannelType.GuildText) await ch.setParent(state.categoryId, { lockPermissions: false }).catch(() => {})
    }
  }
  state.categoryId = await ensureCategory(CATEGORY_NAME, state.categoryId)
  // In forum mode the archive category is only created if archiving falls back to it.
  state.archiveCategoryId =
    cfg.archiveCategoryName && !cfg.archiveForumName ? await ensureCategory(cfg.archiveCategoryName, state.archiveCategoryId) : state.archiveCategoryId
  // Sessions archived before endedAt existed: start their cleanup clock now.
  for (const st of Object.values(state.sessions)) if (st.ended && !st.endedAt) st.endedAt = Date.now()
  // Sessions recorded before lastPrompt existed: recover it from the transcript once.
  for (const st of Object.values(state.sessions)) {
    if (st.lastPrompt || !st.transcript) continue
    try {
      const ctx: RenderContext = { toolNames: new Map(), showToolCalls: false }
      const plain = new JsonlTail(st.transcript).read().flatMap(o => renderRecord(o, ctx)).filter(b => b.plain)
      if (plain.length) st.lastPrompt = plain[plain.length - 1].plain!.replace(/\s+/g, ' ').slice(0, 200)
    } catch {}
  }
  stateDirty = true
  // Needs the applications.commands scope; the ! commands keep working without it.
  await guild.commands
    .set(SLASH_COMMANDS.map(c => c.toJSON()))
    .catch(e => log(`slash commands not registered (${e?.message}); re-invite the bot with the applications.commands scope`))
  await lockDown()
  if (MACHINE) {
    await machineTick().catch(e => log('devices update failed:', e?.message ?? e))
    setInterval(() => void machineTick().catch(e => log('devices update failed:', e?.message ?? e)), DEVICES_REFRESH_MS)
    void tagOwnPosts().catch(e => log('tagging forum posts failed:', e?.message ?? e))
    log(`multi-machine mode: this is "${MACHINE}"`)
  }
  log(`syncing into ${guild.name} (${guild.id})`)
  startIpc()
  setInterval(() => void tick(), TICK_MS)
  void tick()
})

client.on('error', e => log('client error:', e.message))

async function shutdown() {
  // Tell the other computers right away instead of letting the entry go stale.
  if (MACHINE && guild) await Promise.race([heartbeat(true).catch(() => {}), Bun.sleep(2000)])
  saveState()
  if (!IS_WIN) rmSync(SOCKET_PATH, { force: true })
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// Two daemons would steal each other's socket and both drive the bot. Exit 0 so
// systemd / launchd don't keep restarting this one.
if (await daemonRunning()) {
  log(`another daemon is already running (${SOCKET_PATH}); exiting`)
  process.exit(0)
}

client.login(cfg.token).catch(e => {
  log('login failed:', e.message)
  process.exit(1)
})
