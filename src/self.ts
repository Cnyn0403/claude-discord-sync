/**
 * How to invoke this program's own subcommands, whether it runs from source
 * (`bun src/cli.ts <sub>`) or as a compiled single-file executable (`claude-discord-sync <sub>`).
 */
import { join } from 'path'

/** Compiled executables serve their modules from an embedded filesystem. */
export const COMPILED = import.meta.url.includes('$bunfs') || import.meta.url.includes('~BUN')

const CLI = join(import.meta.dir, 'cli.ts')

/** argv to run `sub` with `args`: [program, ...arguments]. */
export function selfCommand(sub: string, ...args: string[]): string[] {
  return COMPILED ? [process.execPath, sub, ...args] : [process.execPath, CLI, sub, ...args]
}
