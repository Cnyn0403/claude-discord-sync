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
  type Message,
  type Interaction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type MessageActionRowComponentBuilder,
  AttachmentBuilder,
} from 'discord.js'
import { createServer, type Socket } from 'net'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, chmodSync, statSync } from 'fs'
import { basename, join, resolve } from 'path'
import { loadConfig, STATE_DIR, SOCKET_PATH } from './config'
import { scanSessions, findTranscript, JsonlTail, type LiveSession } from './sessions'
import { renderRecord, titleOf, pack, chunk, type Block, type RenderContext, type Post } from './render'
import { send as ipcSend, onLines, type ClientMsg, type AskQuestion } from './ipc'

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
  /** When the current busy stretch started, for the "done" notification. */
  busySince?: number
  /** A stop-hook flag file is waiting for this session's next tool call. */
  stopFlag?: boolean
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
  t.ctx.askOnDiscord = peers.has(s.pid)
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
  // ccd sessions post AskUserQuestion interactively via ask-hook.ts instead.
  t.ctx.askOnDiscord = !!t.live && peers.has(t.live.pid)
  const blocks: Block[] = []
  let newTitle: string | undefined
  for (const o of records) {
    const title = titleOf(o)
    if (title && title !== t.st.title) newTitle = title
    blocks.push(...renderRecord(o, t.ctx))
  }
  t.st.offset = t.tail.offset
  stateDirty = true
  if (blocks.length) void post(t, pack(blocks, cfg.attachOver))
  if (newTitle) {
    t.st.title = newTitle
    // Topic edits are rate limited (2 per 10 min per channel); titles change rarely.
    void channelOf(t).then(ch => ch?.setTopic(topicFor(t.sessionId, t.st)).catch(() => {}))
  }
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`
}

/** @-mention the user when Claude finishes a turn, so they know to come back. */
function notifyWhenDone(t: Tracked) {
  const status = t.live?.status
  if (status === 'busy') {
    t.busySince ??= Date.now()
    return
  }
  if (status === 'idle' && t.stopFlag) clearStopFlag(t)
  // Other non-idle states (e.g. waiting on a prompt) keep the stretch open.
  if (status !== 'idle' || t.busySince === undefined) return
  const elapsed = Date.now() - t.busySince
  t.busySince = undefined
  if (cfg.notifyMinBusySec < 0 || elapsed < cfg.notifyMinBusySec * 1000 || !cfg.allowFrom.length) return
  // A pending question already pinged them.
  if ([...asks.values(), ...plans.values()].some(a => a.channelId === t.st.channelId)) return
  const mentions = cfg.allowFrom.map(id => `<@${id}>`).join(' ')
  void channelOf(t).then(ch => {
    if (!ch) return
    void enqueue(ch.id, () =>
      ch.send({ content: `${mentions} ✅ Claude 完成了（${formatDuration(elapsed)}）`, allowedMentions: { users: cfg.allowFrom } }),
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
  if (/^!new(\s|$)/.test(msg.content)) {
    if (!cfg.allowFrom.includes(msg.author.id)) void msg.react('🚫').catch(() => {})
    else await startNewSession(msg).catch(e => void msg.reply(`⚠️ 啟動失敗：${e?.message ?? e}`).catch(() => {}))
    return
  }
  const t = trackedByChannel(msg.channelId)
  if (!t) {
    if (/^!resume\s*$/i.test(msg.content)) {
      if (!cfg.allowFrom.includes(msg.author.id)) void msg.react('🚫').catch(() => {})
      else await resumeSession(msg).catch(e => void msg.reply(`⚠️ 恢復失敗：${e?.message ?? e}`).catch(() => {}))
    }
    return
  }
  if (!cfg.allowFrom.includes(msg.author.id)) {
    void msg.react('🚫').catch(() => {})
    return
  }
  const peer = t.live ? peers.get(t.live.pid) : undefined
  if (/^!stop\s*$/i.test(msg.content)) {
    await stopSession(t, msg, peer).catch(e => void msg.reply(`⚠️ 停止失敗：${e?.message ?? e}`).catch(() => {}))
    return
  }
  if (/^!end\s*$/i.test(msg.content)) {
    await endSession(t, msg, peer).catch(e => void msg.reply(`⚠️ 結束失敗：${e?.message ?? e}`).catch(() => {}))
    return
  }
  if (/^!resume\s*$/i.test(msg.content)) {
    await msg.reply('這個 session 還在執行中。')
    return
  }
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
  if ((i.isButton() || i.isStringSelectMenu() || i.isModalSubmit()) && i.customId.startsWith('ask')) {
    await handleAskInteraction(i).catch(e => log('ask interaction failed:', e?.message ?? e))
    return
  }
  if ((i.isButton() || i.isModalSubmit()) && i.customId.startsWith('plan')) {
    await handlePlanInteraction(i).catch(e => log('plan interaction failed:', e?.message ?? e))
    return
  }
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
    return `**❓ ${n > 1 ? `(${i + 1}) ` : ''}${q.question}**${q.multiSelect ? '（可複選）' : ''}\n${opts}${ans !== undefined ? `\n↳ ✅ **${ans}**` : ''}`
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
    options.push({ label: '其他（自己輸入）…', value: OTHER, description: '用文字回答' })
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
      new ButtonBuilder().setCustomId(`askterm:${key}`).setLabel('改在終端機回答').setEmoji('⌨️').setStyle(ButtonStyle.Secondary),
    ),
  )
  return rows.slice(0, 5)
}

async function startAsk(sock: Socket, sessionId: string, questions: AskQuestion[]) {
  const t = tracked.get(sessionId)
  const ch = t && (await channelOf(t))
  // Discord allows 5 component rows: up to 4 questions + the terminal button.
  if (!ch || !questions.length || questions.length > 4) {
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
      void ch.messages.edit(a.messageId, { content: askContent(a, '-# ⏱️ 已逾時，改在終端機回答'), components: [] }).catch(() => {})
  })
  const mentions = cfg.allowFrom.map(id => `<@${id}>`).join(' ')
  const sent = await enqueue(ch.id, () =>
    ch.send({
      content: clip(`${mentions}\n${askContent(a)}`, 2000),
      components: askComponents(key, a),
      allowedMentions: { users: cfg.allowFrom },
    }),
  )
  a.messageId = sent.id
}

async function handleAskInteraction(i: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction) {
  const m = /^ask(term|other)?:(\w+)(?::(\d+))?$/.exec(i.customId)
  if (!m) return
  if (!cfg.allowFrom.includes(i.user.id)) {
    await i.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }
  const [, kind, key, qs] = m
  const a = asks.get(key)
  if (!a) {
    await i.reply({ content: '這個問題已經結束了。', ephemeral: true })
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
    await settle(undefined, `-# ⌨️ 改在終端機回答（${i.user.username}）`)
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
        .setLabel(clip(q.header || '你的回答', 45))
        .setPlaceholder(clip(q.question, 100))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
      await i.showModal(
        new ModalBuilder()
          .setCustomId(`askother:${key}:${qi}`)
          .setTitle('其他')
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
    await settle(answers, `-# ✅ 已由 ${i.user.username} 回答`)
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
  if (!ch) {
    ipcSend(sock, { t: 'ask_result' })
    return
  }
  const key = Math.random().toString(36).slice(2, 10)
  const mentions = cfg.allowFrom.map(id => `<@${id}>`).join(' ')
  const full = `📋 **計畫待確認**\n${plan}`
  // Long plans: preview in the message, full text attached.
  const long = full.length > 1800
  const p: PendingPlan = { sock, channelId: ch.id, content: long ? chunk(full, 1700)[0] + '\n-# 📎 完整計畫見附檔' : full }
  plans.set(key, p)
  sock.on('close', () => {
    if (plans.get(key) !== p) return
    plans.delete(key)
    if (p.messageId) void ch.messages.edit(p.messageId, { content: `${p.content}\n\n-# ⏱️ 已逾時，改在終端機回答`, components: [] }).catch(() => {})
  })
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`plan:approve:${key}`).setLabel('核准').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`plan:revise:${key}`).setLabel('繼續修改').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`plan:term:${key}`).setLabel('改在終端機回答').setEmoji('⌨️').setStyle(ButtonStyle.Secondary),
  )
  const sent = await enqueue(ch.id, () =>
    ch.send({
      content: `${mentions}\n${p.content}`.slice(0, 2000),
      components: [row],
      files: long ? [new AttachmentBuilder(Buffer.from(plan, 'utf8'), { name: 'plan.md' })] : [],
      allowedMentions: { users: cfg.allowFrom },
    }),
  )
  p.messageId = sent.id
}

async function handlePlanInteraction(i: ButtonInteraction | ModalSubmitInteraction) {
  const m = /^plan(?::(approve|revise|term)|fb):(\w+)$/.exec(i.customId)
  if (!m) return
  if (!cfg.allowFrom.includes(i.user.id)) {
    await i.reply({ content: 'Not authorized.', ephemeral: true })
    return
  }
  const [, action, key] = m
  const p = plans.get(key)
  if (!p) {
    await i.reply({ content: '這個計畫已經處理過了。', ephemeral: true })
    return
  }
  if (action === 'revise') {
    const input = new TextInputBuilder()
      .setCustomId('text')
      .setLabel('要修改的地方')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
    await (i as ButtonInteraction).showModal(
      new ModalBuilder()
        .setCustomId(`planfb:${key}`)
        .setTitle('繼續修改計畫')
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    )
    return
  }
  plans.delete(key)
  let footer: string
  if (action === 'approve') {
    ipcSend(p.sock, { t: 'plan_result', approved: true })
    footer = `**✅ 已核准**（${i.user.username}）`
  } else if (action === 'term') {
    ipcSend(p.sock, { t: 'ask_result' })
    footer = `-# ⌨️ 改在終端機回答（${i.user.username}）`
  } else {
    const feedback = (i as ModalSubmitInteraction).fields.getTextInputValue('text').trim()
    ipcSend(p.sock, { t: 'plan_result', approved: false, feedback })
    footer = `**✏️ 要求修改**（${i.user.username}）\n${quoteLines(feedback)}`
  }
  const opts = { content: `${p.content}\n\n${footer}`.slice(0, 2000), components: [] }
  if (i.isModalSubmit() && !i.isFromMessage()) await i.reply(opts)
  else await (i as ButtonInteraction).update(opts)
}

const quoteLines = (s: string) => s.split('\n').map(l => '> ' + l).join('\n')

// ---- !new: start a ccd session in tmux --------------------------------------

const run = promisify(execFile)
const CCD = resolve(import.meta.dir, '..', 'bin', 'ccd')
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

/** `!new <dir> [prompt]`: launch `ccd` in a detached tmux session; its channel appears once it registers. */
async function startNewSession(msg: Message) {
  const m = /^!new\s+(\S+)(?:\s+([\s\S]+))?$/.exec(msg.content.trim())
  if (!m) {
    await msg.reply('用法：`!new <資料夾> [第一句話]`，例如 `!new ~/proj 幫我看一下測試為什麼失敗`')
    return
  }
  const dir = resolve(m[1].replace(/^~(?=\/|$)/, homedir()))
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    await msg.reply(`⚠️ 找不到資料夾 \`${dir}\``)
    return
  }
  await launchInTmux(msg, dir, m[2] ? [m[2].trim()] : [])
}

/** `!resume` in an ended session's channel: `ccd --resume <id>` in tmux; the channel moves back when it registers. */
async function resumeSession(msg: Message) {
  const entry = Object.entries(state.sessions).find(([, st]) => st.channelId === msg.channelId)
  if (!entry) return
  const [sessionId, st] = entry
  if (!statSync(st.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    await msg.reply(`⚠️ 找不到資料夾 \`${st.cwd}\``)
    return
  }
  await launchInTmux(msg, st.cwd, ['--resume', sessionId])
}

/** Run ccd with `args` in a detached tmux session and report its channel once it registers. */
async function launchInTmux(msg: Message, dir: string, args: string[]) {
  const name = `ccd-${Math.random().toString(36).slice(2, 6)}`
  const cmd = ['exec', CCD, ...args].map((a, i) => (i ? shq(a) : a)).join(' ')
  // `exec` makes the pane's process Claude Code itself, so pane_pid identifies the session.
  // remain-on-exit keeps the screen around if it dies during startup, so we can show why.
  const { stdout } = await run('tmux', [
    'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', name, '-x', '200', '-y', '50', '-c', dir, cmd,
    ';', 'set-option', '-t', name, 'remain-on-exit', 'on',
  ])
  const panePid = Number(stdout.trim())
  const status = await msg.reply(`🚀 已在 tmux \`${name}\` 啟動，等待 session 註冊…\n-# 本機可以用 \`tmux attach -t ${name}\` 接手`)

  const answered = new Set<RegExp>()
  let downs = 0
  const deadline = Date.now() + NEW_TIMEOUT_MS
  let screen = ''
  while (Date.now() < deadline) {
    await Bun.sleep(1000)
    const t = trackedByPid(panePid)
    if (t?.st.channelId) {
      await run('tmux', ['set-option', '-t', name, 'remain-on-exit', 'off']).catch(() => {})
      await status.edit(`✅ 已啟動 \`${name}\` → <#${t.st.channelId}>\n-# 本機可以用 \`tmux attach -t ${name}\` 接手`)
      return
    }
    let dead: string
    try {
      screen = (await run('tmux', ['capture-pane', '-p', '-t', name])).stdout
      dead = (await run('tmux', ['display-message', '-p', '-t', name, '#{pane_dead} #{pane_dead_status}'])).stdout.trim()
    } catch {
      await status.edit(`⚠️ tmux \`${name}\` 已經結束，Claude Code 可能啟動失敗。`)
      return
    }
    if (dead.startsWith('1')) {
      await run('tmux', ['kill-session', '-t', name]).catch(() => {})
      await status.edit(`⚠️ Claude Code 啟動失敗（exit ${dead.split(' ')[1] || '?'}），最後的畫面：\n${screenBlock(screen)}`)
      return
    }
    const prompt = STARTUP_PROMPTS.find(p => p.re.test(screen) && !answered.has(p.re))
    if (prompt) {
      const key = downs < 5 ? dialogKey(screen, prompt.accept) : 'Enter'
      if (key === 'Enter') {
        answered.add(prompt.re)
        downs = 0
      } else {
        downs++
      }
      await run('tmux', ['send-keys', '-t', name, key])
    }
  }
  await status.edit(`⚠️ ${NEW_TIMEOUT_MS / 1000} 秒內沒看到 session 啟動，目前畫面：\n${screenBlock(screen)}`)
}

function screenBlock(screen: string): string {
  const tail = screen.split('\n').filter(l => l.trim()).slice(-20).join('\n') || '(空白)'
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

/** The tmux pane Claude Code runs in, from its environment. */
function tmuxPaneOf(pid: number): { socket: string; pane: string } | undefined {
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

function typeViaPeer(peer: Socket, text: string): Promise<{ ok: boolean; error?: string }> {
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
    ipcSend(peer, { t: 'type', text })
  })
}

/**
 * Type into the session: via tmux when it runs in tmux (`tmuxKeys` are send-keys
 * argument lists), otherwise through the channel server's terminal (`text`).
 */
async function typeInto(
  pid: number,
  peer: Socket | undefined,
  text: string,
  tmuxKeys: string[][],
): Promise<{ via?: 'tmux' | '終端機'; error?: string }> {
  const tmux = tmuxPaneOf(pid)
  if (tmux) {
    try {
      for (const keys of tmuxKeys) await run('tmux', ['-S', tmux.socket, 'send-keys', '-t', tmux.pane, ...keys])
      return { via: 'tmux' }
    } catch (e: any) {
      return { error: e?.message ?? String(e) }
    }
  }
  if (peer) {
    const r = await typeViaPeer(peer, text)
    return r.ok ? { via: '終端機' } : { error: r.error }
  }
  return { error: '這個 session 沒有在 tmux 裡，也沒有載入 discord-sync channel' }
}

/**
 * Press Esc in the session: via tmux when it runs in tmux, otherwise via the
 * channel server's terminal. If that fails or doesn't take, leave a flag for
 * stop-hook.sh to stop Claude before its next tool call.
 */
async function stopSession(t: Tracked, msg: Message, peer: Socket | undefined) {
  if (t.live?.status !== 'busy') {
    // Esc on an idle prompt is harmless once, but a double Esc opens the rewind menu.
    await msg.reply('Claude 目前沒在工作。')
    return
  }
  const pid = t.live.pid
  const { via, error } = await typeInto(pid, peer, '\x1b', [['Escape']])
  if (error) {
    if (!peer) {
      await msg.reply(`⚠️ 送不出 Esc：${error}`)
      return
    }
    setStopFlag(t)
    await msg.reply(`⚠️ 送不出 Esc（${error}），改成在 Claude 下一次使用工具前停止。`)
    return
  }
  void msg.react('⏹️').catch(() => {})
  const reply = await msg.reply(`⏹️ 已送出 Esc（${via}），確認中…`)
  await Bun.sleep(4000)
  if (t.live?.pid === pid && t.live.status === 'busy' && peer) {
    setStopFlag(t)
    await reply.edit('⏹️ 已送出 Esc，但 Claude 看起來還在工作，會在它下一次使用工具前停止。')
  } else {
    await reply.edit('⏹️ 已中斷。')
  }
}

/** `!end`: interrupt if busy, then type `/exit`. The channel is archived when the process goes away. */
async function endSession(t: Tracked, msg: Message, peer: Socket | undefined) {
  const pid = t.live?.pid
  if (!pid) return
  if (t.live?.status === 'busy') {
    const { error } = await typeInto(pid, peer, '\x1b', [['Escape']])
    if (error) {
      await msg.reply(`⚠️ 沒辦法中斷目前的工作：${error}`)
      return
    }
    await Bun.sleep(1500)
  }
  const { via, error } = await typeInto(pid, peer, '/exit\r', [['-l', '/exit'], ['Enter']])
  if (error) {
    await msg.reply(`⚠️ 沒辦法結束：${error}`)
    return
  }
  const reply = await msg.reply(`👋 已送出 \`/exit\`（${via}），等待 session 結束…`)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await Bun.sleep(1000)
    if (!tracked.has(t.sessionId)) {
      await reply.edit('👋 Session 已結束，之後可以在這裡輸入 `!resume` 恢復。').catch(() => {})
      return
    }
  }
  await reply.edit('⚠️ 送出 `/exit` 後 15 秒 session 還在，可能有對話框擋住了。').catch(() => {})
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
  if (msg.t === 'type_result') {
    interruptWaiters.get(sock)?.(msg)
    return
  }
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
