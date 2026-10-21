#!/usr/bin/env bash
# Updates a Nawlogic Invoice install made with scripts/install.sh.
#
#   sudo ./scripts/update.sh
#
# Order: encrypted backup with the current version first (the update stops if
# it fails), then the new code, a fresh build and a restart. The image that was
# running is kept as nawlogic-invoice:previous for a quick rollback.
# Options: SKIP_PULL=1 (code already updated), SKIP_BACKUP=1 (not recommended).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31mError: %s\033[0m\n' "$*" >&2
  exit 1
}
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
# docker compose with the file list from .env (COMPOSE_FILE), so the Cloudflare
# Tunnel override is picked up when it was chosen at install time.
compose() {
  local files f args=()
  files="$(env_get COMPOSE_FILE)"
  files="${files:-docker-compose.yml}"
  IFS=: read -r -a parts <<<"$files"
  for f in "${parts[@]}"; do args+=(-f "$APP_DIR/$f"); done
  docker compose --project-directory "$APP_DIR" "${args[@]}" --env-file "$ENV_FILE" "$@"
}

app_health() {
  local id
  id="$(compose ps -q app 2>/dev/null || true)"
  [[ -n "$id" ]] || return 1
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null
}

main() {
  [[ $EUID -eq 0 ]] || die "Run as root, for example: sudo $0"
  [[ -f "$ENV_FILE" ]] || die "No .env found in $APP_DIR. Run scripts/install.sh first."
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Run scripts/install.sh first."

  say "1/5 Encrypted backup of the current data"
  if [[ "${SKIP_BACKUP:-}" == 1 ]]; then
    warn "Skipping the backup (SKIP_BACKUP=1)."
  elif docker image inspect nawlogic-invoice:local >/dev/null 2>&1; then
    # Runs with the version that is installed now, before anything changes.
    compose run --rm --no-deps -T app node server/cli.mjs backup ||
      die "The backup failed, so nothing was changed. Check BACKUP_KEY and the backup folder, then try again."
    note "Backup saved in $(grep -E '^BACKUP_HOST_DIR=' "$ENV_FILE" | cut -d= -f2- || echo the backup folder)."
  else
    warn "No installed image found; nothing to back up yet."
  fi

  say "2/5 New version"
  if [[ "${SKIP_PULL:-}" == 1 ]]; then
    note "Using the code already in $APP_DIR."
  elif [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" pull --ff-only || die "Could not update the code (local changes?). Update it yourself, then run again with SKIP_PULL=1."
  else
    warn "$APP_DIR is not a git copy. Put the new version there, then run again with SKIP_PULL=1."
    exit 1
  fi

  say "3/5 Keep the running version for rollback"
  if docker image inspect nawlogic-invoice:local >/dev/null 2>&1; then
    docker tag nawlogic-invoice:local nawlogic-invoice:previous
    note "Saved as nawlogic-invoice:previous."
  fi

  say "4/5 Build and restart"
  compose build --pull app
  compose pull --ignore-buildable
  compose up -d --remove-orphans

  say "5/5 Health check"
  local i status=""
  for i in $(seq 1 30); do
    status="$(app_health || true)"
    [[ "$status" == "healthy" ]] && break
    sleep 4
  done
  if [[ "$status" == "healthy" ]]; then
    note "The app is running and healthy."
  else
    warn "The app is not healthy yet (status: ${status:-unknown}). See: docker compose logs app"
    cat <<EOF
  To go back to the previous version:
    docker tag nawlogic-invoice:previous nawlogic-invoice:local
    docker compose --project-directory $APP_DIR up -d --no-build
  Database changes are not undone by a rollback. Each schema change first
  saves a private copy next to the database (*.pre-*.sqlite) and the backup
  from step 1 is in the backup folder; see docs/DEPLOYMENT.md before restoring.
EOF
    exit 1
  fi
  docker image prune -f >/dev/null 2>&1 || true
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
