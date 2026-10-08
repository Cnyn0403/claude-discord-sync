#!/usr/bin/env bun
/**
 * Replace this executable with the latest release and restart the daemon.
 *
 *   claude-discord-sync update [--pre] [--version <tag>] [--force]
 */
import { chmodSync, renameSync, rmSync, writeFileSync } from 'fs'
import { readConfigFile } from './config'
import { IS_MAC, IS_WIN } from './platform'
import { COMPILED } from './self'
import { VERSION } from './version'
import { autostartInstalled, daemonRunning, installAutostart } from './autostart'

const REPO = 'Cnyn0403/claude-discord-sync'

const text = {
  en: {
    source: 'This is a source checkout; update it with: git pull && bun install',
    checking: 'Checking for updates…',
    noRelease: (pre: boolean) => `No release found.${pre ? '' : ' (Only prereleases so far? Try --pre.)'}`,
    upToDate: (v: string) => `Already up to date (${v}).`,
    downloading: (from: string, to: string) => `Updating ${from} → ${to}…`,
    noAsset: (a: string) => `This release has no build for this platform (${a}).`,
    badChecksum: 'Checksum mismatch; the update was not installed.',
    restarted: '✓ Restarted the daemon',
    restartByHand: '⚠️  A daemon you started by hand is still running the old version; restart it.',
    done: (v: string) => `✓ Updated to ${v}. Sessions started with ccd switch over when you restart them.`,
    failed: (e: string) => `✗ Update failed: ${e}`,
  },
  'zh-TW': {
    source: '這是從原始碼安裝的版本，請用這個指令更新：git pull && bun install',
    checking: '正在檢查更新…',
    noRelease: (pre: boolean) => `找不到任何版本。${pre ? '' : '（目前可能只有測試版，可以加上 --pre 再試一次。）'}`,
    upToDate: (v: string) => `已經是最新版（${v}）。`,
    downloading: (from: string, to: string) => `正在從 ${from} 更新到 ${to}…`,
    noAsset: (a: string) => `這個版本沒有適用於這個平台的執行檔（${a}）。`,
    badChecksum: 'checksum 不符，沒有安裝這次更新。',
    restarted: '✓ 已重新啟動 daemon',
    restartByHand: '⚠️  你手動啟動的 daemon 還在跑舊版，請重新啟動它。',
    done: (v: string) => `✓ 已更新到 ${v}。用 ccd 開著的 session 重新啟動後就會換成新版。`,
    failed: (e: string) => `✗ 更新失敗：${e}`,
  },
}
const t = text[readConfigFile().language === 'zh-TW' ? 'zh-TW' : 'en']

const args = process.argv.slice(2)
const pre = args.includes('--pre')
const force = args.includes('--force')
const pinned = args.includes('--version') ? args[args.indexOf('--version') + 1] : undefined

async function gh<T>(path: string): Promise<T | undefined> {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { 'User-Agent': 'claude-discord-sync', Accept: 'application/vnd.github+json' },
  })
  return res.ok ? ((await res.json()) as T) : undefined
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

async function main() {
  if (!COMPILED) return console.log(t.source)
  console.log(t.checking)
  const tag =
    pinned ??
    (pre
      ? (await gh<{ tag_name: string; draft: boolean }[]>('/releases?per_page=20'))?.find(r => !r.draft)?.tag_name
      : (await gh<{ tag_name: string }>('/releases/latest'))?.tag_name)
  if (!tag) return console.log(t.noRelease(pre))
  if (tag === VERSION && !force) return console.log(t.upToDate(VERSION))

  const asset = `claude-discord-sync-${IS_WIN ? 'windows' : IS_MAC ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}${IS_WIN ? '.exe' : ''}`
  console.log(t.downloading(VERSION, tag))
  const base = `https://github.com/${REPO}/releases/download/${tag}`
  const sums = (await download(`${base}/SHA256SUMS`)).toString('utf8')
  const expected = sums
    .split('\n')
    .map(l => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0]
  if (!expected) throw new Error(t.noAsset(asset))
  const bin = await download(`${base}/${asset}`)
  if (new Bun.CryptoHasher('sha256').update(bin).digest('hex') !== expected.toLowerCase()) throw new Error(t.badChecksum)

  const exe = process.execPath
  if (IS_WIN) {
    // A running .exe can't be overwritten, but it can be renamed out of the way.
    rmSync(`${exe}.old`, { force: true })
    renameSync(exe, `${exe}.old`)
    writeFileSync(exe, bin)
  } else {
    // rename() swaps the file atomically; running processes keep the old one.
    writeFileSync(`${exe}.new`, bin)
    chmodSync(`${exe}.new`, 0o755)
    renameSync(`${exe}.new`, exe)
  }

  if (autostartInstalled()) {
    installAutostart()
    console.log(t.restarted)
  } else if (await daemonRunning()) {
    console.log(t.restartByHand)
  }
  console.log(t.done(tag))
}

try {
  // A previous Windows update leaves the old executable behind; it's free to delete by now.
  if (IS_WIN && COMPILED) rmSync(`${process.execPath}.old`, { force: true })
} catch {}
try {
  await main()
  process.exit(0)
} catch (e: any) {
  console.log(t.failed(String(e?.message ?? e)))
  process.exit(1)
}
