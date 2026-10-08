/**
 * Keys typed into a session's terminal by /stop, /end and the startup-dialog
 * handling of /new, and how each backend spells them.
 */
import { openSync, closeSync } from 'fs'
import { spawnSync } from 'child_process'
import { IS_LINUX, IS_MAC } from './platform'

/** BackTab is Shift+Tab, which cycles Claude Code's permission mode. */
export type Key = 'Escape' | 'Enter' | 'Down' | 'BackTab' | { text: string }

export function keysToTty(keys: Key[]): string {
  return keys.map(k => (k === 'Escape' ? '\x1b' : k === 'Enter' ? '\r' : k === 'Down' ? '\x1b[B' : k === 'BackTab' ? '\x1b[Z' : k.text)).join('')
}

/** Argument lists for `tmux send-keys`, one invocation each. */
export function keysToTmux(keys: Key[]): string[][] {
  return keys.map(k => (k === 'BackTab' ? ['BTab'] : typeof k === 'string' ? [k] : ['-l', k.text]))
}

/**
 * Type into our controlling terminal, which is Claude Code's when called from
 * the channel server: TIOCSTI queues bytes as if they were typed.
 * - Linux: ioctl through Bun FFI. Linux 6.2+ can disable it (dev.tty.legacy_tiocsti=0).
 * - macOS: through the system Perl. ioctl is variadic, and on Apple Silicon a
 *   variadic argument passed through FFI lands in the wrong place.
 */
export function typeIntoOwnTty(text: string): { ok: boolean; error?: string } {
  if (IS_LINUX) return tiocstiLinux(text)
  if (IS_MAC) return tiocstiPerl(text)
  return { ok: false, error: 'no TIOCSTI on this platform' }
}

function tiocstiLinux(text: string): { ok: boolean; error?: string } {
  let fd: number | undefined
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    const libc = dlopen('libc.so.6', { ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 } })
    fd = openSync('/dev/tty', 'r+')
    // TIOCSTI queues one byte per call.
    const bytes = new TextEncoder().encode(text)
    for (let i = 0; i < bytes.length; i++) {
      if (libc.symbols.ioctl(fd, 0x5412, ptr(bytes, i)) !== 0) return { ok: false, error: 'TIOCSTI rejected' }
    }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function tiocstiPerl(text: string): { ok: boolean; error?: string } {
  // 0x80017472 = TIOCSTI on macOS (_IOW('t', 114, char)). The text arrives on stdin.
  const script = 'open(my $t, "+<", "/dev/tty") or exit 2; local $/; my $s = <STDIN>; for my $c (split //, $s) { ioctl($t, 0x80017472, $c) or exit 3 }'
  const r = spawnSync('/usr/bin/perl', ['-e', script], { input: text, timeout: 5000 })
  if (r.status === 0) return { ok: true }
  return { ok: false, error: r.status === 2 ? 'no controlling terminal' : r.status === 3 ? 'TIOCSTI rejected' : String(r.error ?? `perl exit ${r.status}`) }
}
