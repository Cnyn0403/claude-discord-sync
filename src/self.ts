/**
 * How to invoke this program's own subcommands, whether it runs from source
 * (`bun src/cli.ts <sub>`) or as a compiled single-file executable (`claude-discord-sync <sub>`).
 */
import { join } from 'path'

/** Compiled executables serve their modules from an embedded filesystem: /$bunfs/… or, on Windows, B:\\~BUN\\… */
export const COMPILED = import.meta.path.includes('$bunfs') || import.meta.path.includes('~BUN')

const CLI = join(import.meta.dir, 'cli.ts')

/** argv to run `sub` with `args`: [program, ...arguments]. */
export function selfCommand(sub: string, ...args: string[]): string[] {
  return COMPILED ? [process.execPath, sub, ...args] : [process.execPath, CLI, sub, ...args]
}
