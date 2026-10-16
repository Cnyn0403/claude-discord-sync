/**
 * `claude-discord-sync pause|unpause [all]`: run inside a Claude Code session
 * (e.g. `! claude-discord-sync pause`) it affects that session; elsewhere, or
 * with `all`, every session on this computer.
 */
import { connect } from 'net'
import { SOCKET_PATH, readConfigFile } from './config'
import { pickLanguage } from './i18n'
import { findClaudePid } from './sessions'
import { send, onLines, type DaemonMsg } from './ipc'

export async function run(paused: boolean) {
  const all = process.argv.slice(2).some(a => a === 'all' || a === '--all')
  const pid = all ? undefined : findClaudePid(process.ppid)
  const notRunning =
    {
      en: 'The daemon is not running; start it first.',
      'zh-TW': 'daemon 沒有在執行，請先啟動它。',
      'zh-CN': 'daemon 没有在运行，请先启动它。',
    }[pickLanguage(readConfigFile().language)]
  const text = await new Promise<string | undefined>(resolve => {
    const sock = connect(SOCKET_PATH)
    sock.on('connect', () => send(sock, { t: 'pause', paused, ...(pid ? { pid } : {}) }))
    onLines<DaemonMsg>(sock, msg => {
      if (msg.t === 'pause_result') {
        sock.destroy()
        resolve(msg.text)
      }
    })
    sock.on('error', () => resolve(undefined))
    setTimeout(() => resolve(undefined), 5000)
  })
  console.log(text ?? notRunning)
  process.exit(text ? 0 : 1)
}
