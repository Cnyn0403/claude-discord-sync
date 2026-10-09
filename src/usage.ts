/**
 * Usage numbers from the status line snapshots ccd sessions leave in
 * status/<session>.json (see statusline.ts). Field names follow the JSON Claude
 * Code gives status line commands; everything is optional because the
 * snapshot's shape is Claude Code's, not ours.
 */
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { STATUS_DIR } from './statusline'

export type PlanLimit = { pct: number; resetsAt?: number }

export type Snapshot = {
  /** When the status line last wrote it (ms). */
  at: number
  model?: string
  context?: { pct?: number; used?: number; size?: number }
  totalIn?: number
  totalOut?: number
  durationMs?: number
  linesAdded?: number
  linesRemoved?: number
  /** Plan limits; account-wide, so the newest snapshot of any session is the current one. */
  fiveHour?: PlanLimit
  sevenDay?: PlanLimit
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** resets_at as ms: Unix seconds, milliseconds or an ISO string. */
function resetTime(v: unknown): number | undefined {
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? undefined : t
  }
  const n = num(v)
  return n === undefined ? undefined : n < 1e12 ? n * 1000 : n
}

function limit(v: any): PlanLimit | undefined {
  const pct = num(v?.used_percentage) ?? num(v?.utilization)
  return pct === undefined ? undefined : { pct, resetsAt: resetTime(v?.resets_at) }
}

export function parseSnapshot(data: any, at: number): Snapshot {
  const cw = data?.context_window ?? {}
  const cu = cw.current_usage
  const used = cu ? (num(cu.input_tokens) ?? 0) + (num(cu.cache_creation_input_tokens) ?? 0) + (num(cu.cache_read_input_tokens) ?? 0) : undefined
  const size = num(cw.context_window_size)
  const pct = num(cw.used_percentage) ?? (used !== undefined && size ? (used / size) * 100 : undefined)
  return {
    at,
    model: typeof data?.model?.display_name === 'string' ? data.model.display_name : typeof data?.model?.id === 'string' ? data.model.id : undefined,
    context: pct !== undefined || used !== undefined ? { pct, used, size } : undefined,
    totalIn: num(cw.total_input_tokens),
    totalOut: num(cw.total_output_tokens),
    durationMs: num(data?.cost?.total_duration_ms),
    linesAdded: num(data?.cost?.total_lines_added),
    linesRemoved: num(data?.cost?.total_lines_removed),
    fiveHour: limit(data?.rate_limits?.five_hour),
    sevenDay: limit(data?.rate_limits?.seven_day),
  }
}

const cache = new Map<string, Snapshot>()

/** The session's latest snapshot, re-read only when the file changed. */
export function readSnapshot(sessionId: string): Snapshot | undefined {
  const file = join(STATUS_DIR, `${sessionId}.json`)
  const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs
  if (mtime === undefined) return undefined
  const hit = cache.get(sessionId)
  if (hit?.at === mtime) return hit
  try {
    const snap = parseSnapshot(JSON.parse(readFileSync(file, 'utf8')), mtime)
    cache.set(sessionId, snap)
    return snap
  } catch {
    return hit
  }
}

/** 351k, 1.2M */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}
