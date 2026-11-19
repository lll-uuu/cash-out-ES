#!/usr/bin/env bash
# One run of the hourly workflow stays alive for several hours: it marbles once now, then once
# at the start of every following hour, then hands over to a fresh run. GitHub's own hourly
# schedule is best-effort and often skips hours, so it only stays on as a backup.
set -euo pipefail
ROUNDS="${ROUNDS:-5}"
FINAL=$(node -e 'console.log(Math.floor(Date.parse(require("./lib").CONFIG.finalAt)/1000))')

git config user.name "cash-out"
git config user.email "cash-out@users.noreply.github.com"

marble() {
  node collect.js
  node render-frame.js --latest --size 1600 --force
  git add data frames
  if git diff --cached --quiet; then echo "nothing new"; return 0; fi
  git commit -q -m "marble $(date -u +%Y-%m-%dT%HZ)"
  for i in 1 2 3; do git pull -q --rebase --autostash && git push -q && return 0; sleep 10; done
  echo "push failed"; return 1
}

for round in $(seq 1 "$ROUNDS"); do
  echo "::group::round $round, $(date -u +%H:%MZ)"
  marble || true
  echo "::endgroup::"
  now=$(date +%s)
  [ "$now" -gt "$FINAL" ] && { echo "polls closed, stopping"; exit 0; }
  [ "$round" -eq "$ROUNDS" ] && break
  next=$(( (now / 3600 + 1) * 3600 + 60 ))   # one minute past the next hour
  echo "sleeping $(( next - now )) s"
  sleep $(( next - now ))
done
