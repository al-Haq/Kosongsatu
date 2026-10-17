#!/usr/bin/env bash
# One-command install of Nawlogic Invoice on a fresh Ubuntu or Debian server.
#
# On the server, from a copy of this repository (for example in /opt/nawlogic):
#   sudo ./scripts/install.sh
#
# Without questions (all three values from the environment):
#   sudo DOMAIN=billing.example.com ACME_EMAIL=you@example.com OWNER_EMAIL=you@example.com ./scripts/install.sh
#
# Optional: ENABLE_UFW=1 turns on the ufw firewall (SSH, 80 and 443 allowed first).
# What it does: installs Docker from Docker's apt repository, writes a private
# .env with new encryption keys (existing keys are never replaced), opens the
# firewall for SSH/HTTP/HTTPS, builds the app, creates the owner account, starts
# the app behind Caddy (automatic HTTPS) and prints the next steps.
# The server, the domain and its DNS record are yours to set up first.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_HOST_DIR_DEFAULT="$APP_DIR/backups"
NODE_UID=1000 # the "node" user inside the app container

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() {
  printf '\033[31mError: %s\033[0m\n' "$*" >&2
  exit 1
}

# ask VAR "Question" [default]: keeps a value already set in the environment.
ask() {
  local var="$1" question="$2" default="${3:-}" answer=""
  if [[ -n "${!var:-}" ]]; then return 0; fi
  if [[ ! -t 0 ]]; then
    [[ -n "$default" ]] || die "$var is required. Set it in the environment when running without a terminal."
    printf -v "$var" '%s' "$default"
    return 0
  fi
  read -r -p "$question${default:+ [$default]}: " answer
  printf -v "$var" '%s' "${answer:-$default}"
}

valid_domain() {
  local re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
  [[ "$1" =~ $re ]]
}
valid_email() {
  local re='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$'
  [[ "$1" =~ $re ]]
}

# A new 32-byte key, base64 encoded (the format BACKUP_KEY and MFA_ENCRYPTION_KEY need).
new_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
    printf '\n'
  fi
}

# env_get KEY: the value in .env, or nothing.
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}
# env_default KEY VALUE: writes the value only when the key is missing or empty.
# Used for keys: an existing key is never replaced (old backups need it).
env_default() {
  local key="$1" value="$2"
  [[ -n "$(env_get "$key")" ]] && return 0
  env_set "$key" "$value"
}
# env_set KEY VALUE: writes or replaces the value.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  if [[ -f "$ENV_FILE" ]]; then grep -vE "^$key=" "$ENV_FILE" >"$tmp" || true; fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}
write_env() {
  umask 077
  [[ -f "$ENV_FILE" ]] || printf '# Nawlogic Invoice production settings. Private: keep a copy in your password manager.\n' >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  env_set DOMAIN "$DOMAIN"
  env_set ACME_EMAIL "$ACME_EMAIL"
  env_set APP_URL "https://$DOMAIN"
  env_default NODE_ENV production
  env_default TRUST_PROXY 1
  env_default BACKUP_HOST_DIR "$BACKUP_HOST_DIR_DEFAULT"
  env_default BACKUP_KEY "$(new_key)"
  env_default MFA_ENCRYPTION_KEY "$(new_key)"
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    note "Docker and Docker Compose are already installed."
    return 0
  fi
  # Docker's own apt repository (docs.docker.com/engine/install).
  local codename
  codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
  [[ -n "$codename" ]] || die "Could not tell the $ID release name."
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

open_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    warn "ufw is not installed. In your provider's firewall, allow only ports 22, 80 and 443."
    return 0
  fi
  ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  if ufw status | grep -q "Status: active"; then
    note "Firewall (ufw): SSH, HTTP and HTTPS allowed."
  elif [[ "${ENABLE_UFW:-}" == 1 ]]; then
    ufw --force enable
  else
    warn "ufw is off. SSH, 80 and 443 are allowed; turn it on with: sudo ufw enable"
  fi
}

check_dns() {
  local resolved
  resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  if [[ -z "$resolved" ]]; then
    warn "$DOMAIN does not resolve yet. Add a DNS A record for it with this server's public IP address."
    warn "HTTPS starts working a few minutes after the record exists; Caddy keeps retrying."
    if [[ -t 0 ]]; then
      local go=""
      read -r -p "Continue anyway? [y/N]: " go
      [[ "$go" =~ ^[Yy] ]] || die "Stopped. Run the script again after adding the DNS record."
    fi
  else
    note "$DOMAIN points to: $resolved"
    note "This server's addresses: $(hostname -I 2>/dev/null || echo unknown)"
  fi
}

compose() { docker compose --project-directory "$APP_DIR" -f "$APP_DIR/docker-compose.yml" --env-file "$ENV_FILE" "$@"; }

create_owner() {
  local out password
  out="$(compose run --rm --no-deps -T -e ADMIN_EMAIL="$OWNER_EMAIL" app node server/cli.mjs setup 2>&1)" || true
  if grep -q "Owner already exists" <<<"$out"; then
    OWNER_NOTE="An owner account already exists. Its password was not changed."
  elif grep -q "Owner created" <<<"$out"; then
    password="$(awk '/Save this password/ { getline; print; exit }' <<<"$out")"
    OWNER_NOTE="Owner: $OWNER_EMAIL
  Password: $password
  Save this password in your password manager now. It is not stored anywhere else."
  else
    printf '%s\n' "$out" >&2
    die "Could not create the owner account."
  fi
}

wait_for_https() {
  local i
  for i in $(seq 1 36); do
    if curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}

main() {
  [[ $EUID -eq 0 ]] || die "Run as root, for example: sudo $0"
  [[ -f "$APP_DIR/docker-compose.yml" ]] || die "Run this from a copy of the Nawlogic repository."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu | debian) ;;
    *) [[ "${FORCE:-}" == 1 ]] || die "This script supports Ubuntu and Debian. Set FORCE=1 to try anyway." ;;
  esac

  say "1/7 Your domain and email"
  ask DOMAIN "Domain for the app, e.g. billing.example.com"
  DOMAIN="$(tr '[:upper:]' '[:lower:]' <<<"$DOMAIN")"
  valid_domain "$DOMAIN" || die "\"$DOMAIN\" is not a valid domain name."
  ask ACME_EMAIL "Email for certificate notices from Let's Encrypt"
  valid_email "$ACME_EMAIL" || die "\"$ACME_EMAIL\" is not a valid email address."
  ask OWNER_EMAIL "Owner sign-in email" "$ACME_EMAIL"
  valid_email "$OWNER_EMAIL" || die "\"$OWNER_EMAIL\" is not a valid email address."

  say "2/7 Docker"
  install_docker

  say "3/7 DNS"
  check_dns

  say "4/7 Private settings (.env) and backup folder"
  write_env
  BACKUP_HOST_DIR="$(env_get BACKUP_HOST_DIR)"
  mkdir -p "$BACKUP_HOST_DIR"
  chown "$NODE_UID:$NODE_UID" "$BACKUP_HOST_DIR"
  chmod 700 "$BACKUP_HOST_DIR"
  note "Settings: $ENV_FILE (readable by root only)"
  note "Encrypted backups: $BACKUP_HOST_DIR"

  say "5/7 Firewall"
  open_firewall

  say "6/7 Build the app and create the owner account"
  compose build
  create_owner

  say "7/7 Start"
  compose up -d
  note "Waiting for https://$DOMAIN (the first certificate can take a minute)..."
  if wait_for_https; then
    note "https://$DOMAIN is up."
  else
    warn "https://$DOMAIN did not answer yet. Check DNS and ports 80/443, then: docker compose logs caddy"
  fi

  say "Done. Next steps"
  cat <<EOF
  1. Open https://$DOMAIN and sign in.
  $OWNER_NOTE
  2. Change the password in Settings and turn on the authenticator (MFA).
  3. Copy $ENV_FILE to your password manager. BACKUP_KEY and MFA_ENCRYPTION_KEY
     are needed to restore a backup; without them a backup cannot be read.
  4. In Settings, fill in your company details, bank details and SST number.
  5. Copy the encrypted backups in $BACKUP_HOST_DIR off this server every day
     (see "Backups off the server" in docs/DEPLOYMENT.md).
  6. Optional: email (SMTP), Billplz and other keys in Settings > Integration keys.
  7. To update later: sudo $APP_DIR/scripts/update.sh
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
