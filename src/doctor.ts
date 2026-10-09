#!/usr/bin/env bun
/** Read-only setup check: bot login, guilds, permissions, live sessions. Creates nothing. */
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js'
import { loadConfig, STATE_DIR } from './config'
import { scanSessions, findTranscript } from './sessions'
import { hasTmux, IS_WIN } from './platform'

const cfg = loadConfig()
console.log(`state dir:   ${STATE_DIR}`)
console.log(`allowFrom:   ${cfg.allowFrom.join(', ') || '(empty!)'}`)
console.log(`guildId:     ${cfg.guildId ?? '(auto)'}`)
console.log(`platform:    ${process.platform} ${process.arch}`)
console.log(`/new:        ${hasTmux() ? 'tmux' : IS_WIN ? 'new console window (experimental)' : 'unavailable: install tmux'}`)

console.log('\nlive sessions:')
for (const s of scanSessions()) {
  const mirrored = !s.kind || cfg.kinds.includes(s.kind)
  console.log(`  pid ${s.pid}  ${s.sessionId}  ${s.kind ?? '?'}  ${s.status ?? ''}  ${s.cwd}  transcript=${findTranscript(s.sessionId, s.cwd) ? 'yes' : 'not yet'}${mirrored ? '' : '  (skipped: kind)'}`)
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })
client.once('clientReady', async c => {
  console.log(`\nbot: ${c.user.tag}`)
  for (const g of c.guilds.cache.values()) {
    const me = await g.members.fetchMe()
    const need = {
      ManageChannels: PermissionFlagsBits.ManageChannels,
      ManageRoles: PermissionFlagsBits.ManageRoles,
      ManageThreads: PermissionFlagsBits.ManageThreads,
      ManageWebhooks: PermissionFlagsBits.ManageWebhooks,
      SendMessages: PermissionFlagsBits.SendMessages,
      AddReactions: PermissionFlagsBits.AddReactions,
      AttachFiles: PermissionFlagsBits.AttachFiles,
    }
    const perms = Object.entries(need).map(([k, v]) => `${me.permissions.has(v) ? '✓' : '✗'} ${k}`).join('  ')
    console.log(`  guild ${g.id}  ${g.name}\n    ${perms}`)
  }
  await c.destroy()
  process.exit(0)
})
client.login(cfg.token).catch(e => {
  console.error('login failed:', e.message)
  process.exit(1)
})
