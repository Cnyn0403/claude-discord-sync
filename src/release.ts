/**
 * GitHub releases: what `update` installs and what the daemon's update notice
 * compares against.
 */
export const REPO = 'Cnyn0403/claude-discord-sync'

export async function gh<T>(path: string): Promise<T | undefined> {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { 'User-Agent': 'claude-discord-sync', Accept: 'application/vnd.github+json' },
  })
  return res.ok ? ((await res.json()) as T) : undefined
}

/** The latest non-prerelease. */
export async function latestRelease(): Promise<{ tag: string; url: string } | undefined> {
  const r = await gh<{ tag_name: string; html_url: string }>('/releases/latest')
  return r?.tag_name ? { tag: r.tag_name, url: r.html_url } : undefined
}

const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/

/**
 * Whether release tag `a` is newer than `b`. A prerelease (v1.2.0-beta.1) is
 * older than its release; a source checkout's `-dev` counts as the release itself.
 */
export function isNewer(a: string, b: string): boolean {
  const pa = TAG_RE.exec(a)
  const pb = TAG_RE.exec(b)
  if (!pa || !pb) return false
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i])
  const preA = pa[4] === 'dev' ? undefined : pa[4]
  const preB = pb[4] === 'dev' ? undefined : pb[4]
  if (!preA || !preB) return !preA && !!preB
  const sa = preA.split('.')
  const sb = preB.split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] === sb[i]) continue
    if (sa[i] === undefined) return false
    if (sb[i] === undefined) return true
    const na = Number(sa[i])
    const nb = Number(sb[i])
    return Number.isNaN(na) || Number.isNaN(nb) ? sa[i] > sb[i] : na > nb
  }
  return false
}
