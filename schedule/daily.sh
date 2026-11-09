#!/bin/zsh
# Daily unattended data refresh: plain Node — NO Claude session, no token cost, no tool
# permissions to grant. (A headless `claude -p` was tested and has no Artifact tool, so it
# could not sync the board anyway; board sync is done in an interactive session via the
# jobs-sweep skill.) Quota guards inside sweep.mjs keep every API within its allowance.
cd "${0:A:h:h}" || exit 1          # repo root, wherever it was cloned
NODE="$(command -v node || echo /usr/local/bin/node)"   # launchd runs with a minimal PATH
mkdir -p logs
{
  echo "=== $(date '+%Y-%m-%d %H:%M') ==="

  # Observed 4 days straight (Oct 4-7) where every source failed with "fetch failed" —
  # always right at the 07:30 fire time, always network-level. launchd's StartCalendarInterval
  # fires on the wall clock even if the Mac just woke and Wi-Fi isn't associated yet. Wait for
  # a real DNS+TCP path before spending any part of the day's API quota on doomed requests.
  ready=0
  for i in $(seq 1 12); do
    if curl -fsS --max-time 4 -o /dev/null https://api.github.com; then ready=1; break; fi
    sleep 5
  done
  if [ "$ready" = "0" ]; then
    echo "no network after 60s of waiting — skipping this run, nothing was spent"
    echo "=== done (skipped) ==="
    echo
    exit 0
  fi

  "$NODE" scripts/sweep.mjs
  "$NODE" scripts/score.mjs
  echo "=== done ==="
  echo
} >> logs/sweep.log 2>&1
