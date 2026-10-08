#!/usr/bin/env bun
/**
 * PreToolUse hook for AskUserQuestion and ExitPlanMode (installed by `ccd`).
 *
 * Hands the questions / plan to the daemon, which posts them to the session's
 * Discord channel with select menus or buttons:
 *   AskUserQuestion answered -> allow, answers in `updatedInput.answers`
 *   plan approved            -> allow
 *   plan sent back           -> deny, the feedback becomes the reason Claude sees
 * Any failure, timeout, or the "answer in terminal" button prints nothing and
 * exits 0, which falls back to the normal local dialog.
 */
import { connect } from 'net'
import { SOCKET_PATH } from './config'
import { send, onLines, type ClientMsg, type DaemonMsg } from './ipc'

type HookInput = { session_id?: string; tool_name?: string; tool_input?: { questions?: any[]; plan?: string } }
type Reply = Extract<DaemonMsg, { t: 'ask_result' | 'plan_result' }>

const ASK_TIMEOUT_MS = (Number(process.env.DISCORD_SYNC_ASK_TIMEOUT) || 600) * 1000

function askDaemon(msg: ClientMsg): Promise<Reply | undefined> {
  return new Promise(resolve => {
    const sock = connect(SOCKET_PATH)
    const done = (reply?: Reply) => {
      sock.destroy()
      resolve(reply)
    }
    setTimeout(() => done(), ASK_TIMEOUT_MS)
    sock.on('connect', () => send(sock, msg))
    onLines<DaemonMsg>(sock, m => {
      if (m.t === 'ask_result' || m.t === 'plan_result') done(m)
    })
    sock.on('error', () => done())
    sock.on('close', () => done())
  })
}

function decide(decision: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }))
}

try {
  const input = JSON.parse(await Bun.stdin.text()) as HookInput
  const sessionId = input.session_id
  const ti = input.tool_input
  if (sessionId && input.tool_name === 'AskUserQuestion' && Array.isArray(ti?.questions)) {
    const r = await askDaemon({ t: 'ask', sessionId, questions: ti.questions })
    if (r?.t === 'ask_result' && r.answers) {
      decide({ permissionDecision: 'allow', updatedInput: { ...ti, answers: r.answers } })
    }
  } else if (sessionId && input.tool_name === 'ExitPlanMode' && typeof ti?.plan === 'string') {
    const r = await askDaemon({ t: 'plan', sessionId, plan: ti.plan })
    if (r?.t === 'plan_result') {
      decide(
        r.approved
          ? { permissionDecision: 'allow' }
          : {
              permissionDecision: 'deny',
              permissionDecisionReason: `The user asked on Discord to revise the plan. Revise it accordingly and present it again:\n${r.feedback ?? ''}`,
            },
      )
    }
  }
} catch {}
process.exit(0)
