/**
 * OS differences in one place: process tree lookups, the daemon's IPC endpoint,
 * and which way of driving a session's terminal is available.
 */
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { join } from 'path'
import { userInfo } from 'os'

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

function run(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  } catch {
    return undefined
  }
}

/** Fields after the command name in /proc/<pid>/stat (the name may contain spaces). */
function procStat(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  } catch {
    return undefined
  }
}

export function parentPid(pid: number): number | undefined {
  let out: string | undefined
  if (IS_LINUX) out = procStat(pid)?.[1]
  else if (IS_WIN)
    out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`])
  else out = run('ps', ['-o', 'ppid=', '-p', String(pid)])
  const n = Number(out)
  return n > 0 ? n : undefined
}

/** Process start time, to tell a reused PID from the original. Linux only; elsewhere the check is skipped. */
export function procStart(pid: number): string | undefined {
  return IS_LINUX ? procStat(pid)?.[19] : undefined
}

/** Unix socket in the state dir; a per-user, per-state-dir named pipe on Windows. */
export function ipcPath(stateDir: string): string {
  if (!IS_WIN) return join(stateDir, 'daemon.sock')
  const id = createHash('sha256').update(stateDir).digest('hex').slice(0, 12)
  return `\\\\.\\pipe\\claude-discord-sync-${userInfo().username}-${id}`
}

let tmuxCache: boolean | undefined
export function hasTmux(): boolean {
  return (tmuxCache ??= !IS_WIN && run('tmux', ['-V']) !== undefined)
}
