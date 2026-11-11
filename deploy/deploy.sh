#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
APP=/home/ploi/dap.xadi.eu
STATE=/home/ploi/deploy/dap-xadi-eu
PM2_APP=dap-xadi-eu
exec 9>"$STATE/deploy.lock"
flock -w 600 9 || { printf '%s\n' 'ERROR: deployment lock timed out'; exit 1; }
cd "$APP"
printf '[%s] Deployment starting\n' "$(date -u +%FT%TZ)"
[[ "$(git branch --show-current)" == main ]] || { printf '%s\n' 'ERROR: expected main branch'; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { printf '%s\n' 'ERROR: checkout is not clean; refusing to overwrite changes'; exit 1; }
# Do not print Git transport errors: remote URLs may contain credentials.
timeout 120 git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main' > /dev/null 2>&1 || { printf '%s\n' 'ERROR: Git fetch failed (check repository access)'; exit 1; }
previous=$(git rev-parse HEAD)
target=$(git rev-parse origin/main)
# Webhook redeliveries and duplicate pushes: nothing new means no restart. --force deploys anyway.
if [[ "$target" == "$(cat "$STATE/deployed-revision" 2>/dev/null)" && "${1:-}" != --force ]]; then
  printf 'Already live at %s; nothing to do\n' "$target"; exit 0
fi
git merge-base --is-ancestor "$previous" "$target" || { printf '%s\n' 'ERROR: main diverged; manual review required'; exit 1; }
health() {
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 3 http://127.0.0.1:3002/health | node -e '
      let body=""; process.stdin.on("data",d=>body+=d); process.stdin.on("end",()=>{
        try { process.exit(JSON.parse(body).status === "healthy" ? 0 : 1); } catch { process.exit(1); }
      });'; then
      sleep 2
      pm2 jlist | node -e '
        let b=""; process.stdin.on("data",d=>b+=d); process.stdin.on("end",()=>{
          try { const p=JSON.parse(b).find(p=>p.name==="dap-xadi-eu"); process.exit(p?.pm2_env.status==="online" ? 0 : 1); }
          catch { process.exit(1); }
        });' && return 0
    fi
    sleep 1
  done
  return 1
}
recover() {
  result=$?
  trap - ERR
  printf '[%s] ERROR: deployment failed; attempting rollback to %s\n' "$(date -u +%FT%TZ)" "$previous"
  if git reset --keep "$previous" > /dev/null 2>&1 \
     && timeout 300 npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
     && pm2 restart "$PM2_APP" \
     && health; then
    printf '%s\n' 'Rollback succeeded; deployment remains FAILED.'
  else
    printf '%s\n' 'CRITICAL: rollback failed; manual intervention required.'
  fi
  exit "$result"
}
trap recover ERR
# No arbitrary reset on deploy: preserve history and refuse divergence.
git merge --ff-only --quiet "$target"
timeout 300 npm ci --omit=dev --ignore-scripts --no-audit --no-fund
pm2 restart "$PM2_APP"
health
# Write status atomically only after the application is healthy.
printf '%s\n' "$target" > "$STATE/deployed-revision.tmp"
mv "$STATE/deployed-revision.tmp" "$STATE/deployed-revision"
trap - ERR
printf '[%s] Deployment healthy at %s\n' "$(date -u +%FT%TZ)" "$target"
