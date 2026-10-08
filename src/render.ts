/**
 * Turns Claude Code transcript records (one JSONL line each) into Discord-ready text blocks.
 * The transcript format is internal to Claude Code, so everything here is defensive:
 * unknown record shapes are skipped rather than rendered half-broken.
 */

export type Block = { kind: 'user' | 'assistant' | 'tool' | 'question' | 'info'; text: string }

export type RenderContext = {
  /** tool_use_id -> tool name, so tool_result records can be attributed. */
  toolNames: Map<string, string>
  showToolCalls: boolean
  /** AskUserQuestion is posted interactively by the daemon, so don't render it as text. */
  askOnDiscord?: boolean
}

const MAX = 1900

/** Inline code span that survives backticks in the content. */
function code(s: string, max = 160): string {
  const one = s.replace(/\s+/g, ' ').trim()
  const cut = one.length > max ? one.slice(0, max - 1) + '…' : one
  return '`' + cut.replace(/`/g, 'ˋ') + '`'
}

function stripNoise(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim()
}

function quote(s: string): string {
  return s
    .split('\n')
    .map(l => '> ' + l)
    .join('\n')
}

function renderUserText(raw: string): Block | undefined {
  // Messages that came in from Discord are already in the channel.
  if (/<channel source="discord-sync"/.test(raw)) return undefined
  if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr)>/.test(raw.trim())) return undefined
  const cmd = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (cmd) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim()
    return { kind: 'info', text: `-# ⌨️ ${code(cmd[1].trim() + (args ? ' ' + args : ''))}` }
  }
  const bash = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/)
  if (bash) return { kind: 'info', text: `-# 💻 ${code('! ' + bash[1])}` }
  const text = stripNoise(raw)
  if (!text) return undefined
  return { kind: 'user', text: `👤 **本地輸入**\n${quote(text)}` }
}

function summarizeTool(name: string, input: any, ctx: RenderContext): Block | undefined {
  input ??= {}
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    if (ctx.askOnDiscord) return undefined
    const parts = input.questions.map((q: any, i: number) => {
      const opts = (q.options ?? [])
        .map((o: any, j: number) => `  **${j + 1}.** ${o.label}${o.description ? ` — ${o.description}` : ''}`)
        .join('\n')
      return `**❓ ${input.questions.length > 1 ? `(${i + 1}) ` : ''}${q.question}**${q.multiSelect ? '（可複選）' : ''}\n${opts}`
    })
    return { kind: 'question', text: parts.join('\n\n') }
  }
  if (name === 'ExitPlanMode' && typeof input.plan === 'string') {
    if (ctx.askOnDiscord) return undefined
    return { kind: 'question', text: `📋 **計畫待確認**\n${input.plan}` }
  }
  // Our own tools post their own output.
  if (name.startsWith('mcp__discord-sync__')) return undefined

  let detail = ''
  switch (name) {
    case 'Bash':
      detail = code(input.command ?? '')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      detail = code(input.file_path ?? input.notebook_path ?? '')
      break
    case 'Grep':
    case 'Glob':
      detail = code(input.pattern ?? '')
      break
    case 'WebFetch':
      detail = code(input.url ?? '')
      break
    case 'WebSearch':
      detail = code(input.query ?? '')
      break
    case 'Agent':
    case 'Task':
      detail = input.description ? code(input.description) : ''
      break
    default: {
      const first = Object.values(input).find(v => typeof v === 'string') as string | undefined
      detail = first ? code(first, 80) : ''
    }
  }
  return { kind: 'tool', text: `-# 🔧 **${name}** ${detail}`.trimEnd() }
}

export function renderRecord(o: any, ctx: RenderContext): Block[] {
  if (!o || o.isSidechain) return []
  const msg = o.message
  if (o.type === 'user' && msg) {
    if (o.isMeta) return []
    // Anything not typed by a human locally (channel pushes, peer messages, task notifications) is skipped.
    if (o.origin?.kind && o.origin.kind !== 'human') return []
    const c = msg.content
    if (typeof c === 'string') {
      const b = renderUserText(c)
      return b ? [b] : []
    }
    if (!Array.isArray(c)) return []
    const out: Block[] = []
    const texts: string[] = []
    for (const item of c) {
      if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text)
      else if (item?.type === 'image') texts.push('[圖片]')
      else if (item?.type === 'tool_result') {
        const tool = ctx.toolNames.get(item.tool_use_id)
        if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') {
          const body = typeof item.content === 'string' ? item.content : (item.content ?? []).map((x: any) => x?.text ?? '').join('\n')
          out.push({ kind: 'info', text: `-# ↳ ${code(body, 300)}` })
        } else if (item.is_error && ctx.showToolCalls) {
          out.push({ kind: 'tool', text: `-# ⚠️ ${tool ?? 'tool'} 失敗` })
        }
      }
    }
    if (texts.length) {
      const b = renderUserText(texts.join('\n'))
      if (b) out.unshift(b)
    }
    return out
  }
  if (o.type === 'assistant' && Array.isArray(msg?.content)) {
    const out: Block[] = []
    for (const item of msg.content) {
      if (item?.type === 'text' && item.text?.trim()) {
        out.push({ kind: 'assistant', text: item.text.trim() })
      } else if (item?.type === 'tool_use') {
        ctx.toolNames.set(item.id, item.name)
        const b = summarizeTool(item.name, item.input, ctx)
        if (b && (b.kind !== 'tool' || ctx.showToolCalls)) out.push(b)
      }
    }
    return out
  }
  return []
}

/** Title records: Claude Code writes an AI-generated title, or the user sets one with /rename. */
export function titleOf(o: any): string | undefined {
  if (o?.type === 'custom-title' && typeof o.customTitle === 'string') return o.customTitle
  if (o?.type === 'ai-title' && typeof o.aiTitle === 'string') return o.aiTitle
  if (o?.type === 'summary' && typeof o.summary === 'string') return o.summary
  return undefined
}

/** Split text into Discord-sized chunks on line boundaries, re-opening code fences across cuts. */
export function chunk(text: string, max = MAX): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let cur = ''
  let fence: string | undefined
  const flush = () => {
    if (!cur) return
    out.push(fence !== undefined ? cur + '\n```' : cur)
    cur = fence !== undefined ? fence : ''
  }
  for (let line of text.split('\n')) {
    while (line.length > max - 10) {
      // A single giant line: hard-split it.
      if (cur) flush()
      out.push(line.slice(0, max - 10))
      line = line.slice(max - 10)
    }
    if (cur.length + line.length + 1 > max - 4) flush()
    cur = cur ? cur + '\n' + line : line
    const m = line.match(/^\s*(```.*)$/)
    if (m) fence = fence === undefined ? m[1] : undefined
  }
  if (cur) out.push(cur)
  return out
}

/** A Discord message: plain text, or a preview with the full text attached as a file. */
export type Post = string | { content: string; file: string }

/**
 * Pack blocks into as few messages as possible; user/assistant/question blocks start a new message.
 * Standalone blocks longer than `attachOver` become a preview plus an attachment.
 */
export function pack(blocks: Block[], attachOver = Infinity): Post[] {
  const out: Post[] = []
  let cur = ''
  for (const b of blocks) {
    const standalone = b.kind !== 'tool' && b.kind !== 'info'
    if (standalone || cur.length + b.text.length + 1 > MAX) {
      if (cur) out.push(cur)
      cur = ''
    }
    if (standalone && b.text.length > attachOver) {
      out.push({ content: chunk(b.text, MAX - 40)[0] + '\n-# 📎 全文見附檔', file: b.text })
    } else if (standalone) {
      out.push(...chunk(b.text))
    } else {
      cur = cur ? cur + '\n' + b.text : b.text
    }
  }
  if (cur) out.push(cur)
  return out
}
