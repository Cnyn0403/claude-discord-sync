/**
 * The `ccd` command: a tiny shim that runs `claude-discord-sync ccd`.
 * Unix: ~/.local/bin/ccd. Windows: ccd.cmd next to the executable (that folder is on PATH).
 * From a source checkout on Unix it links to bin/ccd instead, which keeps Claude Code on the shell's PID.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync, lstatSync } from 'fs'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { delimiter, dirname, join, resolve } from 'path'
import { IS_WIN } from './platform'
import { COMPILED, selfCommand } from './self'

const MARK = 'claude-discord-sync'
export const SHORTCUT_DIR = IS_WIN ? dirname(process.execPath) : join(homedir(), '.local', 'bin')
export const SHORTCUT = join(SHORTCUT_DIR, IS_WIN ? 'ccd.cmd' : 'ccd')

/** Ours if it mentions us (shim) or links into this checkout. */
function isOurs(): boolean {
  try {
    if (lstatSync(SHORTCUT).isSymbolicLink()) return true
    return readFileSync(SHORTCUT, 'utf8').includes(MARK)
  } catch {
    return false
  }
}

/** Create or refresh the shortcut. Refuses to replace a `ccd` that isn't ours. */
export function installShortcut(): 'created' | 'updated' | 'conflict' {
  const existed = existsSync(SHORTCUT) || isOurs()
  if (existed && !isOurs()) return 'conflict'
  mkdirSync(SHORTCUT_DIR, { recursive: true })
  rmSync(SHORTCUT, { force: true })
  if (IS_WIN) {
    const [exe, ...args] = selfCommand('ccd')
    writeFileSync(SHORTCUT, `@echo off\r\nrem ${MARK}\r\n"${exe}" ${args.map(a => `"${a}"`).join(' ')} %*\r\n`)
  } else if (!COMPILED) {
    symlinkSync(resolve(import.meta.dir, '..', 'bin', 'ccd'), SHORTCUT)
  } else {
    writeFileSync(SHORTCUT, `#!/bin/sh\n# ${MARK}\nexec "${process.execPath}" ccd "$@"\n`)
    chmodSync(SHORTCUT, 0o755)
  }
  return existed ? 'updated' : 'created'
}

export function removeShortcut(): boolean {
  if (!isOurs()) return false
  rmSync(SHORTCUT, { force: true })
  return true
}

/** Whether SHORTCUT_DIR is on PATH for new terminals. */
export function shortcutOnPath(): boolean {
  const norm = (p: string) => (IS_WIN ? resolve(p).toLowerCase() : resolve(p))
  if ((process.env.PATH ?? '').split(delimiter).some(p => p && norm(p) === norm(SHORTCUT_DIR))) return true
  if (!IS_WIN) return false
  // The installer may have just added it to the user PATH, which this process doesn't see yet.
  try {
    const user = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"], {
      encoding: 'utf8',
      windowsHide: true,
    })
    return user.split(';').some(p => p && norm(p) === norm(SHORTCUT_DIR))
  } catch {
    return false
  }
}

/** Windows: add SHORTCUT_DIR to the user PATH (without setx, which truncates long values). */
export function addToUserPath(): void {
  const dir = SHORTCUT_DIR.replace(/'/g, "''")
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p = [Environment]::GetEnvironmentVariable('Path','User'); if (-not $p) { $p = '' }; if (($p -split ';') -notcontains '${dir}') { [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';${dir}').TrimStart(';'), 'User') }`,
    ],
    { windowsHide: true },
  )
}
