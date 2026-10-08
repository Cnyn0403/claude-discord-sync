/** Small terminal prompts shared by setup and uninstall. */
import { createInterface } from 'readline'

export function ask(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = fallback ? ` [${fallback}] ` : ' '
  return new Promise(resolve =>
    rl.question(question + suffix, answer => {
      rl.close()
      resolve(answer.trim() || fallback)
    }),
  )
}

export async function confirm(question: string, dflt = true): Promise<boolean> {
  const a = (await ask(`${question} (${dflt ? 'Y/n' : 'y/N'})`)).toLowerCase()
  return a ? a.startsWith('y') : dflt
}

/** Read a line without echoing it (shows * per character). */
export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return ask(question)
  process.stdout.write(question)
  return new Promise(resolve => {
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(value.trim())
          return
        }
        if (c === '\u0003') process.exit(130)
        if (c === '\u007f' || c === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else if (c >= ' ') {
          value += c
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}
