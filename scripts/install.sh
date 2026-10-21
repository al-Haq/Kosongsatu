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
# Optional: CLOUDFLARE_TUNNEL_TOKEN=<token> puts the app behind a Cloudflare
#   Tunnel instead of Caddy: Cloudflare serves HTTPS, no port 80/443 is opened
#   here, and no certificate email is needed. See docs/DEPLOYMENT.md.
# What it does: installs Docker from Docker's apt repository, writes a private
# .env with new encryption keys (existing keys are never replaced), opens the
# firewall for SSH/HTTP/HTTPS, builds the app, creates the owner account, starts
# the app behind Caddy (automatic HTTPS) and prints the next steps.
# The server, the domain and its DNS record are yours to set up first.
# Several companies on one server: scripts/companies.sh add <name> makes a
# second, fully separate install (own folder, data, keys, owner, domain).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
TUNNEL_ENV_FILE="${TUNNEL_ENV_FILE:-$APP_DIR/.env.cloudflare}" # TUNNEL_TOKEN for cloudflared only
TUNNEL="${TUNNEL:-}" # 1 when a Cloudflare Tunnel token was given (set in main)
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

# ask_optional VAR "Question" [default]: like ask, but an empty answer is allowed.
# The default is not shown (it may be a secret); "[keep current]" says one exists.
ask_optional() {
  local var="$1" question="$2" default="${3:-}" answer=""
  if [[ -n "${!var:-}" ]]; then return 0; fi
  if [[ ! -t 0 ]]; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  read -r -p "$question${default:+ [keep current]}: " answer
  printf -v "$var" '%s' "${answer:-$default}"
}

# A Cloudflare Tunnel token is base64 (standard or URL-safe) and long.
valid_tunnel_token() {
  local re='^[A-Za-z0-9+/=_-]{40,}$'
  [[ "$1" =~ $re ]]
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
# tunnel_token_get: the Cloudflare Tunnel token saved by an earlier run, or nothing.
tunnel_token_get() {
  [[ -f "$TUNNEL_ENV_FILE" ]] || return 0
  grep -E '^TUNNEL_TOKEN=' "$TUNNEL_ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}
# Several companies on one server: each install is its own Compose project, so
# containers, the data volume and the image tag never collide. A fresh install
# takes the name from its folder (/opt/nawlogic-acme -> nawlogic-acme). An
# install from before this option has no COMPOSE_PROJECT_NAME and keeps the
# name docker-compose.yml declares, nawlogic, with its data.
project_from_dir() {
  local name
  name="$(basename "$(cd "$(dirname "$ENV_FILE")" && pwd)")"
  name="$(tr '[:upper:]' '[:lower:]' <<<"$name" | sed -E 's/[^a-z0-9_-]+/-/g; s/^[^a-z0-9]+//; s/-+$//')"
  printf '%s\n' "${name:-nawlogic}"
}
# Before .env exists (a fresh install) the name the installer is about to write
# counts, so a second install on a Caddy server is refused before it builds.
project_name() {
  local p
  p="$(env_get COMPOSE_PROJECT_NAME)"
  if [[ -z "$p" && ! -f "$ENV_FILE" ]]; then p="$(project_from_dir)"; fi
  printf '%s\n' "${p:-nawlogic}"
}
# env_unset KEY: removes the line.
env_unset() {
  [[ -f "$ENV_FILE" ]] || return 0
  local tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  grep -vE "^$1=" "$ENV_FILE" >"$tmp" || true
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
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
  local fresh=""
  if [[ ! -f "$ENV_FILE" ]]; then
    fresh=1
    printf '# Nawlogic Invoice production settings. Private: keep a copy in your password manager.\n' >"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  if [[ -n "$fresh" ]]; then env_set COMPOSE_PROJECT_NAME "$(project_from_dir)"; fi
  env_set DOMAIN "$DOMAIN"
  env_set APP_URL "https://$DOMAIN"
  if [[ -n "$TUNNEL" ]]; then
    # The token goes in its own file that only the cloudflared service reads.
    printf 'TUNNEL_TOKEN=%s\n' "$CLOUDFLARE_TUNNEL_TOKEN" >"$TUNNEL_ENV_FILE"
    chmod 600 "$TUNNEL_ENV_FILE"
    env_set COMPOSE_FILE "docker-compose.yml:deploy/docker-compose.cloudflare.yml"
    # Caddy does not run in tunnel mode; docker-compose.yml still wants a value.
    env_default ACME_EMAIL "$OWNER_EMAIL"
  else
    env_set ACME_EMAIL "$ACME_EMAIL"
    env_unset COMPOSE_FILE
    rm -f "$TUNNEL_ENV_FILE"
  fi
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
  if [[ -z "$TUNNEL" ]]; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw allow 443/udp >/dev/null
  fi
  if ufw status | grep -q "Status: active"; then
    if [[ -n "$TUNNEL" ]]; then note "Firewall (ufw): only SSH allowed; the tunnel needs no open port."; else note "Firewall (ufw): SSH, HTTP and HTTPS allowed."; fi
  elif [[ "${ENABLE_UFW:-}" == 1 ]]; then
    ufw --force enable
  else
    if [[ -n "$TUNNEL" ]]; then warn "ufw is off. Only SSH is allowed; turn it on with: sudo ufw enable"; else warn "ufw is off. SSH, 80 and 443 are allowed; turn it on with: sudo ufw enable"; fi
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

# docker compose with the file list from .env (COMPOSE_FILE), so the Cloudflare
# Tunnel override is picked up when it was chosen at install time.
compose() {
  local files f args=()
  files="$(env_get COMPOSE_FILE)"
  files="${files:-docker-compose.yml}"
  IFS=: read -r -a parts <<<"$files"
  for f in "${parts[@]}"; do args+=(-f "$APP_DIR/$f"); done
  docker compose -p "$(project_name)" --project-directory "$APP_DIR" "${args[@]}" --env-file "$ENV_FILE" "$@"
}

# Ports 80 and 443 can belong to one install only. A second company on the
# same server runs behind its own Cloudflare Tunnel instead of Caddy.
check_ports_free() {
  local other
  other="$(docker ps --filter publish=443 --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | grep -vx "$(project_name)" | grep . | head -n 1 || true)"
  [[ -z "$other" ]] || die "Port 443 is already used by the Docker project \"$other\" on this server. Give this install a Cloudflare Tunnel token instead (see \"Several companies on one server\" in docs/DEPLOYMENT.md)."
}

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
  local saved_token
  saved_token="$(tunnel_token_get)"
  if [[ -n "$saved_token" ]]; then
    ask_optional CLOUDFLARE_TUNNEL_TOKEN "Cloudflare Tunnel token (Enter keeps the saved one, 'none' switches back to Caddy)" "$saved_token"
  else
    ask_optional CLOUDFLARE_TUNNEL_TOKEN "Cloudflare Tunnel token (Enter to use Caddy with Let's Encrypt instead)"
  fi
  # "none" (typed, or CLOUDFLARE_TUNNEL_TOKEN=none unattended) removes a saved token.
  [[ "${CLOUDFLARE_TUNNEL_TOKEN:-}" == "none" ]] && CLOUDFLARE_TUNNEL_TOKEN=""
  TUNNEL=""
  if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    valid_tunnel_token "$CLOUDFLARE_TUNNEL_TOKEN" || die "That does not look like a Cloudflare Tunnel token (copy it from Zero Trust > Networks > Tunnels)."
    TUNNEL=1
    ACME_EMAIL=""
    note "Cloudflare Tunnel: Cloudflare serves HTTPS for $DOMAIN; no certificate email is needed."
    ask OWNER_EMAIL "Owner sign-in email"
  else
    ask ACME_EMAIL "Email for certificate notices from Let's Encrypt"
    valid_email "$ACME_EMAIL" || die "\"$ACME_EMAIL\" is not a valid email address."
    ask OWNER_EMAIL "Owner sign-in email" "$ACME_EMAIL"
  fi
  valid_email "$OWNER_EMAIL" || die "\"$OWNER_EMAIL\" is not a valid email address."

  say "2/7 Docker"
  install_docker

  say "3/7 DNS"
  if [[ -n "$TUNNEL" ]]; then
    note "Cloudflare creates the DNS record for the tunnel's public hostname ($DOMAIN)."
    note "Its service must be http://app:3000 (Zero Trust > Networks > Tunnels > Public hostname)."
  else
    check_ports_free
    check_dns
  fi

  say "4/7 Private settings (.env) and backup folder"
  write_env
  BACKUP_HOST_DIR="$(env_get BACKUP_HOST_DIR)"
  mkdir -p "$BACKUP_HOST_DIR"
  chown "$NODE_UID:$NODE_UID" "$BACKUP_HOST_DIR"
  chmod 700 "$BACKUP_HOST_DIR"
  note "Settings: $ENV_FILE (readable by root only)"
  note "Docker Compose project: $(project_name)"
  [[ -n "$TUNNEL" ]] && note "Cloudflare Tunnel token: $TUNNEL_ENV_FILE (readable by root only)"
  note "Encrypted backups: $BACKUP_HOST_DIR"

  say "5/7 Firewall"
  open_firewall

  say "6/7 Build the app and create the owner account"
  compose build
  create_owner

  say "7/7 Start"
  if [[ -n "$TUNNEL" ]]; then
    # An earlier Caddy install keeps serving 80/443 unless it is stopped: Caddy
    # is only parked behind a profile, which `up` does not stop.
    compose --profile caddy rm -sf caddy >/dev/null 2>&1 || true
  fi
  # --remove-orphans also removes a cloudflared container left from tunnel mode.
  compose up -d --remove-orphans
  note "Waiting for https://$DOMAIN (the first certificate can take a minute)..."
  if wait_for_https; then
    note "https://$DOMAIN is up."
  else
    if [[ -n "$TUNNEL" ]]; then
      warn "https://$DOMAIN did not answer yet. Check the tunnel's public hostname (service http://app:3000) in Cloudflare Zero Trust, then: docker compose logs cloudflared"
    else
      warn "https://$DOMAIN did not answer yet. Check DNS and ports 80/443, then: docker compose logs caddy"
    fi
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
  if [[ -n "$TUNNEL" ]]; then
    cat <<EOF
  8. In Cloudflare, turn on "Always Use HTTPS" for the domain. Off-site backups
     can go to a Cloudflare R2 bucket (Settings > Integration keys; see
     docs/DEPLOYMENT.md, "Cloudflare in front").
EOF
  fi
  cat <<EOF
  Another company on this server, with its own data, domain and login:
     sudo $APP_DIR/scripts/companies.sh add <short-name>
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
