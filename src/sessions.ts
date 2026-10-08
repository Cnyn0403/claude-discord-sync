import { readdirSync, readFileSync, existsSync, openSync, readSync, closeSync, statSync } from 'fs'
import { join } from 'path'
import { SESSIONS_DIR, PROJECTS_DIR } from './config'

/** One entry of Claude Code's live-session registry (~/.claude/sessions/<pid>.json). */
export type LiveSession = {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  status?: string
  kind?: string
  procStart?: string
}

function procStartOf(pid: number): string | undefined {
  try {
    // Field 22 of /proc/<pid>/stat; comm (field 2) may contain spaces, so split after the last ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

export function isAlive(s: Pick<LiveSession, 'pid' | 'procStart'>): boolean {
  try {
    process.kill(s.pid, 0)
  } catch (e: any) {
    if (e?.code !== 'EPERM') return false
  }
  // Guard against PID reuse when the registry entry records the process start time.
  if (s.procStart && process.platform === 'linux') {
    const actual = procStartOf(s.pid)
    if (actual !== undefined && actual !== s.procStart) return false
  }
  return true
}

export function scanSessions(): LiveSession[] {
  let files: string[]
  try {
    files = readdirSync(SESSIONS_DIR).filter(f => /^\d+\.json$/.test(f))
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8')) as LiveSession
      if (s.sessionId && s.pid && isAlive(s)) out.push(s)
    } catch {}
  }
  return out
}

/** Walk up the process tree from `pid` to the nearest Claude Code process with a registry entry. */
export function findClaudePid(pid: number): number | undefined {
  for (let p = pid, depth = 0; p > 1 && depth < 10; depth++) {
    if (existsSync(join(SESSIONS_DIR, `${p}.json`))) return p
    try {
      const stat = readFileSync(`/proc/${p}/stat`, 'utf8')
      p = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    } catch {
      return undefined
    }
  }
  return undefined
}

export function sessionForPid(pid: number): LiveSession | undefined {
  try {
    return JSON.parse(readFileSync(join(SESSIONS_DIR, `${pid}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

export function findTranscript(sessionId: string, cwd: string): string | undefined {
  const direct = join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct
  // Long or unusual cwds get a different project dir name; fall back to a scan.
  try {
    for (const dir of readdirSync(PROJECTS_DIR)) {
      const p = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {}
  return undefined
}

/** Incremental reader for an append-only JSONL file. Only consumes complete lines. */
export class JsonlTail {
  constructor(readonly path: string, public offset = 0) {}

  read(): any[] {
    let size: number
    try {
      size = statSync(this.path).size
    } catch {
      return []
    }
    // Truncated or replaced; start over.
    if (size < this.offset) this.offset = 0
    if (size === this.offset) return []
    const fd = openSync(this.path, 'r')
    const buf = Buffer.alloc(size - this.offset)
    try {
      readSync(fd, buf, 0, buf.length, this.offset)
    } finally {
      closeSync(fd)
    }
    // Stop at the last newline so a half-written line (or a split multi-byte char) waits for the next read.
    const end = buf.lastIndexOf(0x0a)
    if (end < 0) return []
    this.offset += end + 1
    const out: any[] = []
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {}
    }
    return out
  }
}
