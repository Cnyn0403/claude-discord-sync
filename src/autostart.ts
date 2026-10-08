/**
 * Start the daemon at login: a systemd user unit (Linux), a launchd agent
 * (macOS), or a hidden-window script in the Startup folder (Windows; unlike a
 * scheduled task it needs no admin rights).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { connect } from 'net'
import { SOCKET_PATH, STATE_DIR } from './config'
import { IS_MAC, IS_WIN } from './platform'
import { selfCommand } from './self'

const NAME = 'claude-discord-sync'
const LABEL = 'com.github.cnyn0403.claude-discord-sync'
const SYSTEMD_UNIT = join(homedir(), '.config', 'systemd', 'user', `${NAME}.service`)
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
export const MAC_LOG = join(homedir(), 'Library', 'Logs', `${NAME}.log`)
export const WIN_LOG = join(STATE_DIR, 'daemon.log')
const STARTUP_SCRIPT = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.vbs`)

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true })

/** Whether a daemon is answering on the IPC socket right now. */
export function daemonRunning(): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect(SOCKET_PATH)
    const done = (v: boolean) => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    setTimeout(() => done(false), 1000)
  })
}

export function autostartInstalled(): boolean {
  return existsSync(IS_WIN ? STARTUP_SCRIPT : IS_MAC ? LAUNCHD_PLIST : SYSTEMD_UNIT)
}

/** Where the daemon's log ends up, for the setup summary. */
export function logHint(): string {
  return IS_WIN ? WIN_LOG : IS_MAC ? MAC_LOG : `journalctl --user -u ${NAME} -f`
}

/** Windows: stop running daemons (the Startup script can't restart one that's already up). */
function stopWindowsDaemons() {
  try {
    sh('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${NAME}.exe'" | Where-Object { $_.CommandLine -match ' daemon' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    ])
  } catch {}
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Install (or refresh) the login item and (re)start the daemon through it. */
export function installAutostart(): void {
  if (IS_WIN) {
    // wscript runs the daemon with no console window (style 0) and returns immediately.
    const cmdline = selfCommand('daemon', '--log', WIN_LOG).map(a => `"${a}"`).join(' ')
    mkdirSync(dirname(STARTUP_SCRIPT), { recursive: true })
    writeFileSync(STARTUP_SCRIPT, `CreateObject("WScript.Shell").Run "${cmdline.replace(/"/g, '""')}", 0, False\r\n`)
    stopWindowsDaemons()
    sh('wscript.exe', [STARTUP_SCRIPT])
  } else if (IS_MAC) {
    const args = selfCommand('daemon')
      .map(a => `    <string>${xml(a)}</string>`)
      .join('\n')
    mkdirSync(dirname(LAUNCHD_PLIST), { recursive: true })
    mkdirSync(dirname(MAC_LOG), { recursive: true })
    writeFileSync(
      LAUNCHD_PLIST,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(MAC_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(MAC_LOG)}</string>
</dict>
</plist>
`,
    )
    const domain = `gui/${process.getuid!()}`
    try {
      sh('launchctl', ['bootout', `${domain}/${LABEL}`])
    } catch {}
    sh('launchctl', ['bootstrap', domain, LAUNCHD_PLIST])
  } else {
    // systemd splits ExecStart on spaces; quote every word. PATH lets the daemon find tmux and claude.
    const exec = selfCommand('daemon')
      .map(a => `"${a.replace(/"/g, '\\"')}"`)
      .join(' ')
    mkdirSync(dirname(SYSTEMD_UNIT), { recursive: true })
    writeFileSync(
      SYSTEMD_UNIT,
      `[Unit]
Description=Claude Code <-> Discord session sync daemon
After=network-online.target

[Service]
ExecStart=${exec}
Environment="PATH=${process.env.PATH ?? '/usr/bin:/bin'}"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
    )
    sh('systemctl', ['--user', 'daemon-reload'])
    sh('systemctl', ['--user', 'enable', NAME])
    sh('systemctl', ['--user', 'restart', NAME])
  }
}

/** Stop the autostarted daemon and remove the login item. Returns whether anything was removed. */
export function removeAutostart(): boolean {
  if (!autostartInstalled()) return false
  if (IS_WIN) {
    rmSync(STARTUP_SCRIPT, { force: true })
    stopWindowsDaemons()
  } else if (IS_MAC) {
    try {
      sh('launchctl', ['bootout', `gui/${process.getuid!()}/${LABEL}`])
    } catch {}
    rmSync(LAUNCHD_PLIST, { force: true })
  } else {
    try {
      sh('systemctl', ['--user', 'disable', '--now', NAME])
    } catch {}
    rmSync(SYSTEMD_UNIT, { force: true })
    try {
      sh('systemctl', ['--user', 'daemon-reload'])
    } catch {}
  }
  return true
}
