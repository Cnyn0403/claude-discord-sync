/**
 * Claude writes GitHub-flavoured Markdown; Discord renders only part of it.
 * This rewrites what Discord would show as raw syntax, leaving code blocks alone:
 *   tables      -> lists (Discord has no tables; on a phone the pipes are unreadable)
 *   #### and up -> bold lines (Discord has #, ## and ### only)
 *   --- rules   -> dropped
 */

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const TABLE_SEP_RE = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/
const FENCE_RE = /^\s*(```|~~~)/

/** The cells of a table row; `\|` inside a cell stays a pipe. */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map(c => c.replace(/\\\|/g, '|').trim())
}

/** "Header: " before a value; a full-width colon after Chinese or Japanese text. */
const label = (h: string) => {
  const t = h.replace(/\*\*/g, '')
  return /[\u3000-\u9fff\uff00-\uffef]$/.test(t) ? `${t}：` : `${t}: `
}

/** Bold a cell for a list item, without doubling bold it already has. */
const bold = (s: string) => (/^\*\*[^*]+\*\*$/.test(s) ? s : `**${s.replace(/\*\*/g, '')}**`)

/**
 * A table as list items: "- **first** — second" for two columns; for more, the
 * first cell as the item and the others as "header: value" under it. Empty
 * cells are left out.
 */
function tableToList(header: string[], rows: string[][]): string[] {
  const out: string[] = []
  for (const row of rows) {
    const first = row[0] ?? ''
    const rest = row.slice(1).map((v, i) => ({ h: header[i + 1] ?? '', v })).filter(c => c.v)
    if (!first && !rest.length) continue
    if (header.length <= 2) {
      const v = rest[0]?.v
      out.push(first ? `- ${bold(first)}${v ? ` — ${v}` : ''}` : `- ${v}`)
      continue
    }
    out.push(first ? `- ${bold(first)}` : `- ${rest.shift()!.v}`)
    for (const c of rest) out.push(`  - ${c.h ? label(c.h) : ''}${c.v}`)
  }
  return out
}

export function discordify(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const f = FENCE_RE.exec(line)
    if (f) {
      fence = fence === undefined ? f[1] : line.trim().startsWith(fence) ? undefined : fence
      out.push(line)
      continue
    }
    if (fence !== undefined) {
      out.push(line)
      continue
    }
    // A table: a header row, a separator row, then body rows.
    if (TABLE_ROW_RE.test(line) && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      const header = cells(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && TABLE_ROW_RE.test(lines[j])) rows.push(cells(lines[j++]))
      out.push(...tableToList(header, rows))
      i = j - 1
      continue
    }
    const h = /^\s*#{4,6}\s+(.*\S)\s*$/.exec(line)
    if (h) {
      out.push(bold(h[1]))
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}
