import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { setLanguage, m, type Language } from './i18n'

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
export const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions')
export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const STATE_DIR = process.env.DISCORD_SYNC_STATE_DIR ?? join(CLAUDE_DIR, 'channels', 'discord-sync')
export const SOCKET_PATH = join(STATE_DIR, 'daemon.sock')

// The official discord plugin's state dir; used as a fallback for the bot
// token and the allowlist so a user who already set that up needs no config.
const OFFICIAL_DIR = join(CLAUDE_DIR, 'channels', 'discord')

export type Config = {
  token: string
  /** Language of the Discord-facing text: "en" (default) or "zh-TW". */
  language: Language
  /** Guild to create channels in. Auto-detected when the bot is in exactly one guild. */
  guildId?: string
  /** Discord user IDs allowed to talk to sessions and answer permission prompts. */
  allowFrom: string[]
  categoryName: string
  /**
   * Ended sessions become a post in this forum channel (summary, full conversation
   * as .md, resume button) and their text channel is deleted. Empty string = use
   * archiveCategoryName instead.
   */
  archiveForumName: string
  /** Without a forum: ended sessions are moved to this category. Empty string = leave them in place. */
  archiveCategoryName: string
  /** Session kinds (from ~/.claude/sessions/<pid>.json) to mirror. */
  kinds: string[]
  /** How many past messages to post when a channel is created for an existing session. */
  backlog: number
  /** Show one-line summaries of tool calls. */
  showToolCalls: boolean
  /** @-mention allowFrom when Claude goes idle after working at least this many seconds. -1 = never. */
  notifyMinBusySec: number
  /** Replies longer than this many characters are posted as a preview plus a .md attachment. */
  attachOver: number
  /** Channel listing every session with stop/end/resume menus. Empty string = no console. */
  consoleChannelName: string
  /** Delete channels of sessions that ended this many days ago. 0 = keep forever. */
  deleteEndedAfterDays: number
}

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m) out[m[1]] = m[2]
    }
  } catch {}
  return out
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function loadConfig(): Config {
  mkdirSync(STATE_DIR, { recursive: true })
  const file = readJson<Partial<Config>>(join(STATE_DIR, 'config.json')) ?? {}
  const token =
    process.env.DISCORD_BOT_TOKEN ??
    readEnvFile(join(STATE_DIR, '.env')).DISCORD_BOT_TOKEN ??
    readEnvFile(join(OFFICIAL_DIR, '.env')).DISCORD_BOT_TOKEN
  if (!token) {
    throw new Error(`DISCORD_BOT_TOKEN not found (env, ${join(STATE_DIR, '.env')}, or ${join(OFFICIAL_DIR, '.env')})`)
  }
  const language = setLanguage(file.language)
  const officialAccess = readJson<{ allowFrom?: string[] }>(join(OFFICIAL_DIR, 'access.json'))
  return {
    token,
    language,
    guildId: file.guildId,
    allowFrom: file.allowFrom ?? officialAccess?.allowFrom ?? [],
    categoryName: file.categoryName ?? 'Claude Sessions',
    archiveForumName: file.archiveForumName ?? m.archiveForumName,
    archiveCategoryName: file.archiveCategoryName ?? 'Claude Sessions (ended)',
    kinds: file.kinds ?? ['interactive'],
    backlog: file.backlog ?? 15,
    showToolCalls: file.showToolCalls ?? true,
    notifyMinBusySec: file.notifyMinBusySec ?? 15,
    attachOver: file.attachOver ?? 3800,
    consoleChannelName: file.consoleChannelName ?? m.consoleChannelName,
    deleteEndedAfterDays: file.deleteEndedAfterDays ?? 7,
  }
}
