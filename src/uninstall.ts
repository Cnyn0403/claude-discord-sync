#!/usr/bin/env bun
/**
 * Remove claude-discord-sync from this computer: the daemon's autostart, the
 * `ccd` shortcut, the program itself and, if you say so, your config and token.
 *
 *   claude-discord-sync uninstall [--yes] [--purge | --keep-config]
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from 'fs'
import { spawn } from 'child_process'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { STATE_DIR, readConfigFile } from './config'
import { removeAutostart } from './autostart'
import { removeShortcut, removeFromUserPath, SHORTCUT } from './shortcut'
import { COMPILED } from './self'
import { IS_WIN } from './platform'
import { confirm } from './prompt'

const text = {
  en: {
    intro: 'This removes claude-discord-sync from this computer. Continue?',
    autostart: '✓ Stopped the daemon and removed autostart',
    noAutostart: '- No autostart installed',
    shortcut: (p: string) => `✓ Removed ${p}`,
    program: (p: string) => `✓ Removed ${p}`,
    programLater: (p: string) => `✓ ${p} will be deleted in a few seconds`,
    source: (p: string) => `- Source checkout left in place: ${p}`,
    askPurge: (p: string) => `Also delete your config, bot token and state (${p})?`,
    purged: (p: string) => `✓ Deleted ${p}`,
    kept: (p: string) => `- Kept your config, token and state in ${p}`,
    discord: '\nOn Discord, delete the channels yourself, or remove the bot at https://discord.com/developers/applications',
  },
  'zh-TW': {
    intro: '這會把 claude-discord-sync 從這台電腦移除，要繼續嗎？',
    autostart: '✓ 已停止 daemon 並移除自動啟動',
    noAutostart: '- 沒有設定自動啟動',
    shortcut: (p: string) => `✓ 已刪除 ${p}`,
    program: (p: string) => `✓ 已刪除 ${p}`,
    programLater: (p: string) => `✓ ${p} 會在幾秒後刪除`,
    source: (p: string) => `- 原始碼資料夾保留不動：${p}`,
    askPurge: (p: string) => `要一併刪除設定、bot token 和狀態檔（${p}）嗎？`,
    purged: (p: string) => `✓ 已刪除 ${p}`,
    kept: (p: string) => `- 保留了設定、token 和狀態檔：${p}`,
    discord: '\nDiscord 上的頻道請自己刪除，或是到 https://discord.com/developers/applications 刪除 bot',
  },
}
const t = text[readConfigFile().language === 'zh-TW' ? 'zh-TW' : 'en']

const args = process.argv.slice(2)
const interactive = process.stdin.isTTY && !args.includes('--yes')

/** Delete the executable (and the installer's link to it). Windows can't delete a running .exe, so a helper does it after we exit. */
function removeProgram(): string {
  const exe = process.execPath
  const dir = dirname(exe)
  if (IS_WIN) {
    removeFromUserPath()
    const helper = spawn('cmd.exe', ['/d', '/c', `ping -n 3 127.0.0.1 >nul & del /f /q "${exe}" "${exe}.old" & rmdir "${dir}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    helper.unref()
    return t.programLater(exe)
  }
  rmSync(exe, { force: true })
  // install.sh links ~/.local/bin/claude-discord-sync to the executable.
  const link = join(homedir(), '.local', 'bin', 'claude-discord-sync')
  try {
    if (lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === exe) rmSync(link, { force: true })
  } catch {}
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch {}
  return t.program(exe)
}

if (interactive && !(await confirm(t.intro))) process.exit(0)

console.log(removeAutostart() ? t.autostart : t.noAutostart)
if (removeShortcut()) console.log(t.shortcut(SHORTCUT))

const purge = args.includes('--purge') ? true : args.includes('--keep-config') || !interactive ? false : await confirm(t.askPurge(STATE_DIR), false)
if (purge && existsSync(STATE_DIR)) {
  rmSync(STATE_DIR, { recursive: true, force: true })
  console.log(t.purged(STATE_DIR))
} else {
  console.log(t.kept(STATE_DIR))
}

console.log(COMPILED ? removeProgram() : t.source(resolve(import.meta.dir, '..')))
console.log(t.discord)
process.exit(0)
