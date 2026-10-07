#!/usr/bin/env bash
# Blocks until something needs a manager's attention, prints it and exits.
# For managers whose CLI cannot run background waits or receive cross-session
# messages (Codex): run it in the foreground in a loop.
# Events: one of the Goal's tasks changes state, the Goal's inbox file grows, or the timeout passes.
# Usage: scripts/goal/next-event.sh <goal> [timeout seconds, default 1200]
set -u
goal=${1:?usage: next-event.sh <goal> [timeout]}
limit=${2:-1200}
root=$(cd "$(dirname "$0")/../.." && pwd)
inbox="$root/.temp/goal-orchestration/messages/$goal.md"
mkdir -p "$(dirname "$inbox")" && touch "$inbox"
snapshot() { GOAL_ID="$goal" bun "$root/scripts/goal/goalctl.ts" status 2>/dev/null | awk -v g="$goal" '$1 ~ /^G-[0-9]+$/ && $3 == g { print $1, $2 }' | sort; }
before=$(snapshot)
size=$(stat -c %s "$inbox")
end=$(( $(date +%s) + limit ))
while [ "$(date +%s)" -lt "$end" ]; do
  sleep 30
  if [ "$(stat -c %s "$inbox")" -gt "$size" ]; then
    echo "MESSAGE in $inbox:"; tail -c +$((size + 1)) "$inbox"; exit 0
  fi
  now=$(snapshot)
  if [ "$now" != "$before" ]; then
    echo "TASKS changed for $goal:"; diff <(echo "$before") <(echo "$now") | grep -E '^[<>]'; exit 0
  fi
done
echo "TIMEOUT after ${limit}s; no change for $goal"
