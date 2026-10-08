#!/usr/bin/env bun
/**
 * Windows helper: attach to another process's console to type keys into it or
 * read its screen. A process can only be attached to one console, so the daemon
 * runs this as a short-lived child for each call.
 *
 *   bun src/win-console.ts type <pid> '<keys as JSON>'   -> {"ok":true}
 *   bun src/win-console.ts screen <pid>                  -> {"ok":true,"text":"…"}
 */
import { dlopen, FFIType, ptr } from 'bun:ffi'
import type { Key } from './keys'

// Loaded on first use, so a failure surfaces as the JSON error below.
let k32Lib: ReturnType<typeof loadKernel32> | undefined
const k32Proxy = () => (k32Lib ??= loadKernel32())
const loadKernel32 = () => dlopen('kernel32.dll', {
  FreeConsole: { args: [], returns: FFIType.i32 },
  AttachConsole: { args: [FFIType.u32], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
  // HANDLEs are passed as u64 (bigint) so INVALID_HANDLE_VALUE (-1) compares exactly.
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  WriteConsoleInputW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  GetConsoleScreenBufferInfo: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  ReadConsoleOutputCharacterW: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
}).symbols
const k32 = new Proxy({} as ReturnType<typeof loadKernel32>, { get: (_, k) => (k32Proxy() as any)[k] })

const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_READ_WRITE = 3
const OPEN_EXISTING = 3
const KEY_EVENT = 1

const wide = (s: string) => Buffer.from(s + '\0', 'utf16le')

function open(name: 'CONIN$' | 'CONOUT$') {
  const h = BigInt(k32.CreateFileW(ptr(wide(name)), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, 0, 0n))
  // INVALID_HANDLE_VALUE is (HANDLE)-1.
  if (h === 0n || h === 0xffffffffffffffffn) throw new Error(`open ${name} failed (${k32.GetLastError()})`)
  return h
}

function attach(pid: number) {
  k32.FreeConsole()
  if (!k32.AttachConsole(pid)) throw new Error(`AttachConsole(${pid}) failed (${k32.GetLastError()})`)
}

/** One INPUT_RECORD (20 bytes) holding a KEY_EVENT_RECORD. */
function keyRecord(down: boolean, vk: number, char: number, controlState = 0): Buffer {
  const b = Buffer.alloc(20)
  b.writeUInt16LE(KEY_EVENT, 0)
  b.writeInt32LE(down ? 1 : 0, 4) // bKeyDown
  b.writeUInt16LE(1, 8) // wRepeatCount
  b.writeUInt16LE(vk, 10) // wVirtualKeyCode
  b.writeUInt16LE(0, 12) // wVirtualScanCode
  b.writeUInt16LE(char, 14) // uChar.UnicodeChar
  b.writeUInt32LE(controlState, 16) // dwControlKeyState
  return b
}

function records(keys: Key[]): Buffer {
  const out: Buffer[] = []
  const press = (vk: number, char: number, state = 0) => out.push(keyRecord(true, vk, char, state), keyRecord(false, vk, char, state))
  for (const k of keys) {
    if (k === 'Escape') press(0x1b, 0x1b)
    else if (k === 'Enter') press(0x0d, 0x0d)
    else if (k === 'Down') press(0x28, 0)
    else if (k === 'BackTab') press(0x09, 0x09, 0x0010) // SHIFT_PRESSED
    else for (const ch of k.text) press(0, ch.charCodeAt(0))
  }
  return Buffer.concat(out)
}

function typeKeys(pid: number, keys: Key[]) {
  attach(pid)
  const h = open('CONIN$')
  try {
    const recs = records(keys)
    const written = new Uint32Array(1)
    if (!k32.WriteConsoleInputW(h, ptr(recs), recs.length / 20, ptr(written))) throw new Error(`WriteConsoleInputW failed (${k32.GetLastError()})`)
  } finally {
    k32.CloseHandle(h)
  }
}

/** The visible part of the screen buffer, one line per row. */
function screen(pid: number): string {
  attach(pid)
  const h = open('CONOUT$')
  try {
    // CONSOLE_SCREEN_BUFFER_INFO: dwSize, dwCursorPosition, wAttributes, srWindow{L,T,R,B}, dwMaximumWindowSize
    const info = Buffer.alloc(22)
    if (!k32.GetConsoleScreenBufferInfo(h, ptr(info))) throw new Error(`GetConsoleScreenBufferInfo failed (${k32.GetLastError()})`)
    const [left, top, right, bottom] = [info.readInt16LE(10), info.readInt16LE(12), info.readInt16LE(14), info.readInt16LE(16)]
    const width = right - left + 1
    const buf = Buffer.alloc(width * 2)
    const read = new Uint32Array(1)
    const lines: string[] = []
    for (let y = top; y <= bottom; y++) {
      // COORD is passed by value: X in the low word, Y in the high word.
      if (!k32.ReadConsoleOutputCharacterW(h, ptr(buf), width, ((y & 0xffff) << 16) | (left & 0xffff), ptr(read))) break
      lines.push(buf.toString('utf16le', 0, read[0] * 2).trimEnd())
    }
    return lines.join('\n')
  } finally {
    k32.CloseHandle(h)
  }
}

try {
  const [cmd, pidArg, keysArg] = process.argv.slice(2)
  const pid = Number(pidArg)
  if (cmd === 'type') {
    typeKeys(pid, JSON.parse(keysArg) as Key[])
    console.log(JSON.stringify({ ok: true }))
  } else if (cmd === 'screen') {
    console.log(JSON.stringify({ ok: true, text: screen(pid) }))
  } else {
    throw new Error('usage: win-console.ts type <pid> <keys-json> | screen <pid>')
  }
} catch (e: any) {
  console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
}
