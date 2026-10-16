#!/usr/bin/env bun
/**
 * Replace this executable with the latest release and restart the daemon.
 *
 *   claude-discord-sync update [--pre] [--version <tag>] [--force]
 */
import { chmodSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { readConfigFile } from './config'
import { pickLanguage } from './i18n'
import { IS_MAC, IS_WIN } from './platform'
import { COMPILED } from './self'
import { VERSION } from './version'
import { autostartInstalled, daemonRunning, installAutostart } from './autostart'
import { installShortcut, isOurs } from './shortcut'
import { REPO, gh } from './release'

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
  'zh-CN': {
    source: '这是从源码安装的版本，请用这条命令更新：git pull && bun install',
    checking: '正在检查更新…',
    noRelease: (pre: boolean) => `找不到任何版本。${pre ? '' : '（目前可能只有预发布版，可以加上 --pre 再试一次。）'}`,
    upToDate: (v: string) => `已经是最新版（${v}）。`,
    downloading: (from: string, to: string) => `正在从 ${from} 更新到 ${to}…`,
    noAsset: (a: string) => `这个版本没有适用于当前平台的可执行文件（${a}）。`,
    badChecksum: '校验和不匹配，没有安装这次更新。',
    restarted: '✓ 已重启 daemon',
    restartByHand: '⚠️  你手动启动的 daemon 还在运行旧版，请重启它。',
    done: (v: string) => `✓ 已更新到 ${v}。用 ccd 打开的 session 重启后就会换成新版。`,
    failed: (e: string) => `✗ 更新失败：${e}`,
  },
}
const t = text[pickLanguage(readConfigFile().language)]

const args = process.argv.slice(2)
const pre = args.includes('--pre')
const force = args.includes('--force')
const pinned = args.includes('--version') ? args[args.indexOf('--version') + 1] : undefined

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
    // A running .exe can't be overwritten or deleted, but it can be renamed out of the way.
    // An earlier .old may still be running (a ccd session's channel server), so each gets its own name.
    removeOld()
    renameSync(exe, `${exe}.old-${Date.now()}`)
    writeFileSync(exe, bin)
  } else {
    // rename() swaps the file atomically; running processes keep the old one.
    writeFileSync(`${exe}.new`, bin)
    chmodSync(`${exe}.new`, 0o755)
    renameSync(`${exe}.new`, exe)
  }

  if (isOurs()) installShortcut()
  if (autostartInstalled()) {
    installAutostart()
    console.log(t.restarted)
  } else if (await daemonRunning()) {
    console.log(t.restartByHand)
  }
  console.log(t.done(tag))
}

/** Delete the executables earlier Windows updates renamed away; ones still running stay until next time. */
function removeOld() {
  const dir = dirname(process.execPath)
  const prefix = `${basename(process.execPath)}.old`
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(prefix)) continue
    try {
      rmSync(join(dir, f), { force: true })
    } catch {}
  }
}

if (IS_WIN && COMPILED) removeOld()
try {
  await main()
  process.exit(0)
} catch (e: any) {
  console.log(t.failed(String(e?.message ?? e)))
  process.exit(1)
}
