#!/usr/bin/env bash
# One run of the hourly workflow stays alive for several hours: it marbles once now, then once
# at the start of every following hour, then hands over to a fresh run. GitHub's own hourly
# schedule is best-effort and often skips hours, so it only stays on as a backup.
set -euo pipefail
ROUNDS="${ROUNDS:-5}"
FINAL=$(node -e 'console.log(Math.floor(Date.parse(require("./lib").CONFIG.finalAt)/1000))')

git config user.name "cash-out"
git config user.email "cash-out@users.noreply.github.com"

save() {
  git add data frames analysis/otros-mercados.md 2>/dev/null || git add data frames
  if git diff --cached --quiet; then echo "nothing new"; return 0; fi
  git commit -q -m "$1"
  for i in 1 2 3; do git pull -q --rebase --autostash && git push -q && return 0; sleep 10; done
  echo "push failed"; return 1
}

# this hour's frame; if Polymarket or the network fails, try again (up to three times, three minutes apart)
marble() {
  for attempt in 1 2 3; do
    if node collect.js && node render-frame.js --latest --size 1600 --force; then
      save "marble $(date -u +%Y-%m-%dT%HZ)"; return 0
    fi
    echo "attempt $attempt failed"; sleep 180
  done
  return 1
}

# rebuild any hour that has no snapshot (a skipped run, a failed hour) and draw its frame
fill_gaps() {
  node scripts/fill-gaps.js || return 0
  while read -r id; do
    [ -n "$id" ] && node render-frame.js "data/snapshots/$id.json" --size 1600 || true
  done < data/.rebuilt
  save "rebuild missing hours $(date -u +%Y-%m-%dT%HZ)"
}

for round in $(seq 1 "$ROUNDS"); do
  start=$(date +%s)
  echo "::group::round $round, $(date -u +%H:%MZ)"
  marble || echo "this hour failed three times; it will be rebuilt"
  fill_gaps || true
  # the other markets (PP + Vox majority, Vox vote and seats): collect and report, best effort
  { node scripts/collect-extra.js && node scripts/extra-report.js && save "other markets $(date -u +%Y-%m-%dT%HZ)"; } || echo "other markets failed this round"
  echo "::endgroup::"
  now=$(date +%s)
  [ "$now" -gt "$FINAL" ] && { echo "polls closed, stopping"; exit 0; }
  [ "$round" -eq "$ROUNDS" ] && break
  next=$(( (start / 3600 + 1) * 3600 + 60 ))   # one minute past the hour after this round began
  if [ "$next" -gt "$now" ]; then echo "sleeping $(( next - now )) s"; sleep $(( next - now )); fi
done
