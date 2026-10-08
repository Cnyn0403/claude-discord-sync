#!/bin/sh
# PreToolUse hook for every tool (installed by ccd): when discord-sync's !stop
# could not press Esc, it leaves a flag file for the session and this stops
# Claude before its next tool call.
input=$(cat)
dir="${DISCORD_SYNC_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/discord-sync}/stop"
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\([0-9a-zA-Z-]*\)".*/\1/p' | head -n 1)
[ -n "$sid" ] && [ -e "$dir/$sid" ] || exit 0
rm -f "$dir/$sid"
printf '{"continue":false,"stopReason":"已從 Discord 停止"}'
