#!/usr/bin/env bun
/** Remove the login item and the `ccd` shortcut. Config, token and state are kept. */
import { STATE_DIR } from './config'
import { removeAutostart } from './autostart'
import { removeShortcut, SHORTCUT } from './shortcut'
import { COMPILED } from './self'
import { IS_WIN } from './platform'

console.log(removeAutostart() ? '✓ Stopped the daemon and removed autostart' : '- No autostart installed')
console.log(removeShortcut() ? `✓ Removed ${SHORTCUT}` : `- No ccd shortcut of ours at ${SHORTCUT}`)
console.log(`\nKept your config, token and state in ${STATE_DIR} (delete the folder to remove them).`)
if (COMPILED) {
  console.log(
    IS_WIN
      ? `To remove the program, delete ${process.execPath} (and remove its folder from your user PATH).`
      : `To remove the program: rm "${process.execPath}"`,
  )
}
process.exit(0)
