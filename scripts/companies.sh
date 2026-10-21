#!/usr/bin/env bash
# Several companies on one server. Each company is a complete, separate
# Nawlogic install: its own folder next to this one, its own database, backups,
# encryption keys, owner login, domain and Cloudflare Tunnel. Nothing is shared
# between companies except the server.
#
#   sudo ./scripts/companies.sh add <name>       new install in /opt/nawlogic-<name>
#   sudo ./scripts/companies.sh list             every install next to this one
#   sudo ./scripts/companies.sh update [<name>]  update one install, or all of them
#
# Before "add": in Cloudflare Zero Trust create a tunnel for the company (for
# example nawlogic-<name>) with the public hostname you want, service
# http://app:3000, and copy its token; the installer asks for it. Ports 80 and
# 443 can belong to one install only, so every further company runs behind its
# own tunnel. See "Several companies on one server" in docs/DEPLOYMENT.md.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT="$(dirname "$APP_DIR")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31mError: %s\033[0m\n' "$*" >&2
  exit 1
}

# A company's short name becomes part of a folder name and a Compose project
# name, so only lowercase letters, digits and dashes, 2 to 32 characters.
valid_slug() {
  local re='^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$'
  [[ "$1" =~ $re ]]
}
target_dir() { printf '%s/nawlogic-%s\n' "$PARENT" "$1"; }
env_get_in() { grep -E "^$2=" "$1/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
# The Compose project of an install: written by its installer, or the original
# name for an install made before several companies were possible.
project_of() {
  local p
  p="$(env_get_in "$1" COMPOSE_PROJECT_NAME)"
  printf '%s\n' "${p:-nawlogic}"
}
# Every install next to this one, this one included: a folder with the
# installer and a .env written by it.
installs() {
  local d
  for d in "$APP_DIR" "$PARENT"/*/; do
    d="${d%/}"
    [[ -f "$d/scripts/install.sh" && -f "$d/.env" ]] || continue
    printf '%s\n' "$d"
  done | awk '!seen[$0]++'
}
app_status() {
  docker ps --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=app" --format '{{.Status}}' 2>/dev/null | head -n 1 || true
}

cmd_list() {
  local d project domain front status
  printf '%-30s %-24s %-30s %-7s %s\n' FOLDER PROJECT DOMAIN FRONT STATUS
  while IFS= read -r d; do
    project="$(project_of "$d")"
    domain="$(env_get_in "$d" DOMAIN)"
    front=caddy
    [[ -f "$d/.env.cloudflare" ]] && front=tunnel
    status="$(app_status "$project")"
    printf '%-30s %-24s %-30s %-7s %s\n' "$d" "$project" "${domain:-?}" "$front" "${status:-not running}"
  done < <(installs)
}

cmd_add() {
  local slug="${1:-}" target remote
  [[ -n "$slug" ]] || die "Usage: $0 add <name>   (a short name for the company, e.g. acme)"
  valid_slug "$slug" || die "\"$slug\" is not a valid name: lowercase letters, digits and dashes, 2 to 32 characters."
  target="$(target_dir "$slug")"
  [[ ! -e "$target" ]] || die "$target already exists. Pick another name, or run $target/scripts/install.sh to repair that install."
  [[ $EUID -eq 0 ]] || die "Run as root, for example: sudo $0 add $slug"
  command -v git >/dev/null 2>&1 || die "git is not installed (apt-get install -y git)."
  say "New company \"$slug\" in $target"
  note "Same code as $APP_DIR; its own settings, keys, database, backups and owner."
  remote="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
  git clone -q "$APP_DIR" "$target"
  [[ -z "$remote" ]] || git -C "$target" remote set-url origin "$remote"
  cat <<EOF
  The installer now asks for this company's domain, its Cloudflare Tunnel token
  and the owner's sign-in email. Have the token ready: Cloudflare Zero Trust >
  Networks > Tunnels > Create a tunnel (name it nawlogic-$slug), public hostname
  = the company's domain, service HTTP app:3000.
EOF
  exec "$target/scripts/install.sh"
}

cmd_update() {
  local which="${1:-}" d failed=0
  if [[ -n "$which" ]]; then
    if [[ -d "$which" ]]; then d="$(cd "$which" && pwd)"; else d="$(target_dir "$which")"; fi
    [[ -f "$d/scripts/update.sh" ]] || die "No install at $d."
    exec "$d/scripts/update.sh"
  fi
  while IFS= read -r d; do
    say "Update: $d"
    "$d/scripts/update.sh" || {
      failed=1
      warn "The update in $d failed; the other installs continue."
    }
  done < <(installs)
  [[ $failed -eq 0 ]] || exit 1
}

usage() {
  cat <<EOF
Several companies on one server, each with its own Nawlogic install.
  sudo $0 add <name>       new install in $PARENT/nawlogic-<name>
  sudo $0 list             every install next to this one
  sudo $0 update [<name>]  update one install, or all of them
EOF
}

main() {
  case "${1:-}" in
    add) cmd_add "${2:-}" ;;
    list) cmd_list ;;
    update) cmd_update "${2:-}" ;;
    -h | --help | help | "") usage ;;
    *) die "Unknown command \"$1\". Commands: add, list, update." ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
