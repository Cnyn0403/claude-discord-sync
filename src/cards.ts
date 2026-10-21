/**
 * Permission prompts as cards: a coloured embed whose colour says where it
 * stands, so a scroll through the channel shows at a glance what still needs an
 * answer, and whose body shows what the tool will do.
 */
import { EmbedBuilder } from 'discord.js'
import { m } from './i18n'
import { chunk } from './render'

/** The /status panel's colours: yellow for what's under way, green for done, grey for over. */
export const CARD_COLORS = {
  /** Waiting for an answer. */
  pending: 0xfee75c,
  approved: 0x57f287,
  denied: 0xed4245,
  /** Answered in the terminal, or gone. */
  closed: 0x99aab5,
} as const
export type CardState = keyof typeof CARD_COLORS

/** What a card shows: `body` is Markdown; title and footer are plain text in embeds. */
export type Card = { title: string; body: string; footer?: string }

/** Embed titles and footers don't render Markdown. */
const plain = (s: string) => s.replace(/^-#\s*/gm, '').replace(/\*\*|`/g, '')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
/** Embed descriptions allow 4096 characters. */
const DESCRIPTION_MAX = 4000

export function cardEmbed(c: Card, state: CardState, status?: string): EmbedBuilder {
  // Subtext ("-# ") is for message text; in an embed the status should read normally.
  status = status?.replace(/^-#\s*/gm, '')
  const room = DESCRIPTION_MAX - (status ? status.length + 2 : 0)
  // chunk() closes a code fence it cuts through.
  const body = c.body.length > room ? chunk(c.body, room - 2)[0] + '\n…' : c.body
  const e = new EmbedBuilder()
    .setColor(CARD_COLORS[state])
    .setTitle(clip(plain(c.title), 256))
    .setDescription((status ? `${body}\n\n${status}` : body) || '​')
  // The footer says how to answer, so only while there is something to answer.
  if (c.footer && state === 'pending') e.setFooter({ text: clip(plain(c.footer), 2048) })
  return e
}

// ---- what a tool is about to do ------------------------------------------------

const FENCE_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', py: 'py', rs: 'rust', go: 'go',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', lua: 'lua', md: 'md', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  html: 'html', css: 'css', scss: 'scss', sql: 'sql', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  cs: 'cs', rb: 'ruby', php: 'php', swift: 'swift', vue: 'vue', xml: 'xml', ini: 'ini', conf: 'ini', diff: 'diff',
}
const langOf = (path: string) => FENCE_LANG[/\.([\w]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''] ?? ''

const PREVIEW_LINES = 20
const PREVIEW_CHARS = 1500

/** At most PREVIEW_LINES lines / PREVIEW_CHARS characters of `s`, with how much was left out. */
function excerpt(s: string, lines = PREVIEW_LINES): { text: string; more?: number } {
  const all = s.replace(/\s+$/, '').split('\n')
  let text = all.slice(0, lines).join('\n')
  if (text.length > PREVIEW_CHARS) text = text.slice(0, PREVIEW_CHARS) + '…'
  return all.length > lines ? { text, more: all.length } : { text }
}

function fence(lang: string, s: string, lines = PREVIEW_LINES): string {
  const { text, more } = excerpt(s, lines)
  return '```' + lang + '\n' + text.replace(/```/g, 'ˋˋˋ') + '\n```' + (more ? `\n*${m.moreLines(more)}*` : '')
}

const pathLine = (icon: string, path: unknown) => (typeof path === 'string' && path ? `${icon} \`${path.replace(/`/g, 'ˋ')}\`` : '')
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** A diff of an edit: removed lines, then added ones. */
function editDiff(oldS: string, newS: string, lines = 12): string {
  const minus = oldS.split('\n').map(l => '- ' + l)
  const plus = newS.split('\n').map(l => '+ ' + l)
  const take = (xs: string[]) => (xs.length > lines ? [...xs.slice(0, lines), `  … (${xs.length})`] : xs)
  return fence('diff', [...(oldS ? take(minus) : []), ...take(plus)].join('\n'), lines * 2 + 2)
}

/**
 * The body of a permission card: what the tool will do, shown the way the
 * terminal does (the command for Bash, the file and its new content for Write,
 * a diff for Edit), rather than the raw JSON of its input.
 */
export function toolPreview(tool: string, input: Record<string, unknown>): string {
  const parts: string[] = []
  switch (tool) {
    case 'Bash':
      parts.push(fence('bash', str(input.command)))
      break
    case 'Write':
      parts.push(pathLine('📄', input.file_path), fence(langOf(str(input.file_path)), str(input.content)))
      break
    case 'Edit':
      parts.push(
        pathLine('✏️', input.file_path) + (input.replace_all ? ` · ${m.replaceAll}` : ''),
        editDiff(str(input.old_string), str(input.new_string)),
      )
      break
    case 'MultiEdit': {
      parts.push(pathLine('✏️', input.file_path))
      const edits = Array.isArray(input.edits) ? input.edits : []
      for (const e of edits.slice(0, 3)) parts.push(editDiff(str(e?.old_string), str(e?.new_string), 6))
      if (edits.length > 3) parts.push(`*${m.moreEdits(edits.length)}*`)
      break
    }
    case 'NotebookEdit':
      parts.push(pathLine('📓', input.notebook_path), fence('', str(input.new_source)))
      break
    case 'Read':
      parts.push(pathLine('📖', input.file_path))
      break
    case 'Glob':
    case 'Grep':
      parts.push(`🔎 \`${str(input.pattern).replace(/`/g, 'ˋ')}\``, pathLine('📂', input.path))
      break
    case 'WebFetch':
      parts.push(`🌐 ${str(input.url)}`, str(input.prompt) ? `> ${clip(str(input.prompt).replace(/\n/g, ' '), 300)}` : '')
      break
    case 'WebSearch':
      parts.push(`🔎 ${str(input.query)}`)
      break
    case 'Agent':
    case 'Task':
      parts.push(str(input.description) ? `🤖 **${str(input.description)}**` : '', fence('', str(input.prompt), 10))
      break
    default: {
      // MCP tools: "mcp__server__tool".
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      if (mcp) parts.push(`🔌 ${mcp[1]} · ${mcp[2]}`)
      parts.push(fence('json', JSON.stringify(input, null, 2)))
    }
  }
  return parts.filter(Boolean).join('\n')
}
