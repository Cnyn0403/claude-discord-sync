/**
 * A meeting as one self-contained HTML page, laid out like a Discord channel:
 * avatars, names, times, consecutive messages grouped, Discord Markdown
 * rendered (code blocks and tables included), images inline. Avatars and
 * images are embedded as data URIs so the file opens anywhere, offline,
 * long after the thread and the CDN links are gone.
 */
import { readFileSync, statSync } from 'fs'
import { extname } from 'path'

export type HtmlEntry = {
  ts: number
  name: string
  /** owner, collaborator, … or "claude". */
  role: string
  avatar?: string
  text: string
  files?: { name: string; path?: string; url: string }[]
}

export type HtmlMeeting = {
  title: string
  channel?: string
  sessionId: string
  startedAt: number
  endedAt?: number
  conclusion?: string
  handedOff?: boolean
}

export type HtmlLabels = {
  lang: string
  meeting: string
  conclusion: string
  noConclusion: string
  sentToClaude: string
  savedOnly: string
  stillOpen: string
  messages: (n: number) => string
  claudeName: string
  claudeNote: string
  role: (role: string) => string
  fileNotEmbedded: (name: string, path?: string) => string
  generated: string
}

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
/** Keep the page under Discord's 10 MB upload limit with room to spare. */
const IMAGE_BUDGET = 7 * 1024 * 1024
const IMAGE_MAX = 3 * 1024 * 1024
const GROUP_MS = 7 * 60_000

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const avatarCache = new Map<string, string | undefined>()
async function dataUri(url: string | undefined): Promise<string | undefined> {
  if (!url || !/^https:\/\//.test(url)) return undefined
  if (avatarCache.has(url)) return avatarCache.get(url)
  let out: string | undefined
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    const type = res.headers.get('content-type') ?? ''
    if (res.ok && type.startsWith('image/')) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 512 * 1024) out = `data:${type};base64,${buf.toString('base64')}`
    }
  } catch {}
  avatarCache.set(url, out)
  return out
}

// ---- Discord Markdown ---------------------------------------------------------------

function inline(src: string): string {
  const keep: string[] = []
  const hold = (html: string) => `\u0000${keep.push(html) - 1}\u0000`
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${esc(code)}</code>`))
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) => hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`))
  s = s.replace(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, url => hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`))
  s = esc(s)
  s = s
    .replace(/\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<b>$1</b>')
    .replace(/__(?!\s)(.+?)(?<!\s)__/g, '<u>$1</u>')
    .replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, '<i>$1</i>')
    .replace(/(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])/g, '<i>$1</i>')
    .replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<s>$1</s>')
    .replace(/\|\|(?!\s)(.+?)(?<!\s)\|\|/g, '<span class="spoiler" onclick="this.classList.add(\'shown\')">$1</span>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)])
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map(c => c.trim())

/** Discord-flavoured Markdown plus GitHub tables (Claude writes those). */
export function markdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/)
    if (fence) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code${fence[1] ? ` data-lang="${esc(fence[1])}"` : ''}>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      flush()
      const head = cells(line)
      const align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''))
      const rows: string[][] = []
      i++
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]))
      const td = (tag: string, c: string, j: number) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${inline(c)}</${tag}>`
      out.push(
        `<div class="table"><table><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>${rows
          .map(r => `<tr>${r.map((c, j) => td('td', c, j)).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      )
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      flush()
      out.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`)
      continue
    }
    const sub = line.match(/^-#\s+(.+)$/)
    if (sub) {
      flush()
      out.push(`<p class="subtext">${inline(sub[1])}</p>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      flush()
      const quoted: string[] = []
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quoted.push(lines[i].replace(/^>\s?/, ''))
      i--
      out.push(`<blockquote>${markdown(quoted.join('\n'))}</blockquote>`)
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush()
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const depth = Math.min(4, Math.floor((lines[i].match(/^\s*/)![0].length) / 2))
        items.push(`<li${depth ? ` style="margin-left:${depth * 1.25}em"` : ''}>${inline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))}</li>`)
      }
      i--
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    para.push(line)
  }
  flush()
  return out.join('')
}

// ---- page -----------------------------------------------------------------------------

function hue(s: string): number {
  let h = 0
  for (const c of s) h = (h * 31 + c.codePointAt(0)!) % 360
  return h
}

/** Shown as written here (this computer's time zone) until the page's script redoes it in the reader's locale. */
function fallbackTime(ts: number, opts: Intl.DateTimeFormatOptions): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  const date = opts.year ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` : opts.month ? `${p(d.getMonth() + 1)}/${p(d.getDate())}` : ''
  return [date, `${p(d.getHours())}:${p(d.getMinutes())}`].filter(Boolean).join(' ')
}

const time = (ts: number, opts: Intl.DateTimeFormatOptions) =>
  `<time datetime="${new Date(ts).toISOString()}" data-f='${JSON.stringify(opts)}'>${esc(fallbackTime(ts, opts))}</time>`

function duration(ms: number): string {
  const min = Math.round(ms / 60_000)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

export async function meetingHtml(mt: HtmlMeeting, entries: HtmlEntry[], L: HtmlLabels): Promise<string> {
  const avatars = new Map<string, string | undefined>()
  for (const e of entries) if (e.avatar && !avatars.has(e.avatar)) avatars.set(e.avatar, await dataUri(e.avatar))

  let budget = IMAGE_BUDGET
  const fileHtml = (f: NonNullable<HtmlEntry['files']>[number]) => {
    const mime = IMAGE_MIME[extname(f.name).toLowerCase()]
    const size = f.path ? statSync(f.path, { throwIfNoEntry: false })?.size : undefined
    if (mime && f.path && size !== undefined && size <= IMAGE_MAX && size <= budget) {
      budget -= size
      return `<a class="img" href="#" onclick="this.classList.toggle('big');return false"><img src="data:${mime};base64,${readFileSync(f.path).toString('base64')}" alt="${esc(f.name)}"></a>`
    }
    return `<div class="file">📎 ${esc(L.fileNotEmbedded(f.name, f.path))}</div>`
  }

  const people = new Map<string, string>()
  for (const e of entries) if (e.role !== 'claude') people.set(e.name, e.role)

  const groups: string[] = []
  let prev: HtmlEntry | undefined
  let open = false
  for (const e of entries) {
    const same = prev && prev.name === e.name && prev.role === e.role && e.ts - prev.ts < GROUP_MS
    const claude = e.role === 'claude'
    const body = markdown(e.text) + (e.files ?? []).map(fileHtml).join('')
    if (!same) {
      if (open) groups.push('</div></div>')
      const name = claude ? L.claudeName : e.name
      const av = e.avatar ? avatars.get(e.avatar) : undefined
      const avatar = av ? `<img class="av" src="${av}" alt="">` : `<span class="av ph" style="--h:${hue(name)}">${esc([...name][0] ?? '?')}</span>`
      groups.push(
        `<div class="msg${claude ? ' claude' : ''}">${avatar}<div class="col"><div class="who"><b style="--h:${hue(name)}">${esc(name)}</b>` +
          `<span class="tag">${esc(claude ? L.claudeNote : L.role(e.role))}</span>${time(e.ts, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>`,
      )
      open = true
    }
    groups.push(`<div class="body" title="${esc(new Date(e.ts).toISOString())}">${body}</div>`)
    prev = e
  }
  if (open) groups.push('</div></div>')

  const ended = mt.endedAt
  const status = ended === undefined ? L.stillOpen : mt.handedOff ? L.sentToClaude : L.savedOnly
  const title = mt.title.replace(/^🗣️\s*/, '')
  return `<!doctype html>
<html lang="${esc(L.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(L.meeting)}</title>
<style>
:root{--bg:#313338;--panel:#2b2d31;--text:#dbdee1;--muted:#949ba4;--border:#3f4147;--code:#1e1f22;--link:#00a8fc;--claude:rgba(88,101,242,.10);--claude-bar:#5865f2;--quote:#4e5058}
@media (prefers-color-scheme: light){:root{--bg:#ffffff;--panel:#f2f3f5;--text:#313338;--muted:#5c5e66;--border:#e3e5e8;--code:#f2f3f5;--link:#006ce7;--claude:rgba(88,101,242,.08);--quote:#c4c9ce}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.375 "gg sans","Noto Sans TC","Noto Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--panel);border-bottom:1px solid var(--border);padding:20px 16px}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:22px;margin:0 0 6px}
.meta{color:var(--muted);font-size:14px;display:flex;flex-wrap:wrap;gap:4px 16px}
.people{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}
.people span{background:var(--bg);border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-size:13px}
.people i{color:var(--muted);font-style:normal}
.conclusion{margin-top:14px;padding:10px 12px;border-left:4px solid var(--claude-bar);background:var(--bg);border-radius:4px}
.conclusion b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:4px}
main{padding:8px 16px 40px}
.msg{display:flex;gap:16px;padding:8px 8px 4px;margin-top:10px;border-radius:6px}
.msg.claude{background:var(--claude);border-left:3px solid var(--claude-bar)}
.av{width:40px;height:40px;border-radius:50%;flex:none;object-fit:cover}
.av.ph{display:flex;align-items:center;justify-content:center;font-weight:600;color:#fff;background:hsl(var(--h) 45% 45%)}
.col{min-width:0;flex:1}
.who{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.who b{color:hsl(var(--h) 60% 65%)}
@media (prefers-color-scheme: light){.who b{color:hsl(var(--h) 55% 38%)}}
.tag{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:0 5px}
.who time{font-size:12px;color:var(--muted)}
.body{overflow-wrap:anywhere}
.body p{margin:2px 0}
.body h3,.body h4,.body h5{margin:8px 0 2px;line-height:1.25}
.subtext{font-size:13px;color:var(--muted)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
code{background:var(--code);border-radius:4px;padding:.1em .3em;font:85% ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:10px;overflow-x:auto;margin:6px 0}
pre code{padding:0;background:none;font-size:13px;white-space:pre}
blockquote{margin:4px 0;padding:0 0 0 12px;border-left:4px solid var(--quote)}
ul,ol{margin:4px 0;padding-left:1.5em}
.table{overflow-x:auto;margin:6px 0}
table{border-collapse:collapse;font-size:14px}
th,td{border:1px solid var(--border);padding:4px 10px;vertical-align:top}
th{background:var(--panel)}
.spoiler{background:var(--muted);color:transparent;border-radius:3px;cursor:pointer}.spoiler.shown{background:var(--code);color:inherit}
.img img{display:block;max-width:min(400px,100%);max-height:300px;border-radius:6px;margin:6px 0;cursor:zoom-in}
.img.big img{max-width:100%;max-height:none;cursor:zoom-out}
.file{font-size:14px;color:var(--muted);margin:4px 0}
footer{color:var(--muted);font-size:12px;text-align:center;padding:24px 16px}
@media (max-width:600px){.msg{gap:10px}.av{width:32px;height:32px}}
</style>
</head>
<body>
<header><div class="wrap">
<h1>🗣️ ${esc(title)}</h1>
<div class="meta">
<span>${time(mt.startedAt, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}${ended ? ` – ${time(ended, { hour: '2-digit', minute: '2-digit' })} · ${esc(duration(ended - mt.startedAt))}` : ''}</span>
${mt.channel ? `<span>#${esc(mt.channel)}</span>` : ''}
<span>${esc(L.messages(entries.length))}</span>
<span>${esc(status)}</span>
</div>
<div class="people">${[...people].map(([n, r]) => `<span>${esc(n)} <i>${esc(L.role(r))}</i></span>`).join('')}</div>
${ended ? `<div class="conclusion"><b>${esc(L.conclusion)}</b>${mt.conclusion ? markdown(mt.conclusion) : `<span class="subtext">${esc(L.noConclusion)}</span>`}</div>` : ''}
</div></header>
<main><div class="wrap">
${groups.join('\n')}
</div></main>
<footer>${esc(L.generated)} · session ${esc(mt.sessionId)}</footer>
<script>
for (const t of document.querySelectorAll('time[datetime]')) {
  try { t.textContent = new Date(t.getAttribute('datetime')).toLocaleString(undefined, JSON.parse(t.dataset.f)) } catch {}
}
</script>
</body>
</html>
`
}
