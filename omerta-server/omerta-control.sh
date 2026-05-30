#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.vps.yml}"
ENV_FILE="${ENV_FILE:-.env}"
API_URL="${API_URL:-http://127.0.0.1}"
WG_INTERFACE="${WG_INTERFACE:-wg0}"
WG_PORT="${WG_PORT:-51820}"
WG_SUBNET="${WG_SUBNET:-10.8.0.0/24}"
WG_SERVER_IP="${WG_SERVER_IP:-10.8.0.1}"
WG_CLIENT_DNS="${WG_CLIENT_DNS:-1.1.1.1}"

cd "$ROOT_DIR"

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[1;33m%s\033[0m\n' "$*"; }
red() { printf '\033[0;31m%s\033[0m\n' "$*"; }
pause() { read -rp "Tryck Enter for att fortsatta..." _; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    red "Saknar kommando: $1"
    return 1
  fi
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

require_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    red "Hittar inte $ENV_FILE i $ROOT_DIR."
    echo "Kor forst deploy-scriptet eller skapa .env fran .env.vps.example."
    return 1
  fi
}

env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2-
}

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48
    echo
  fi
}

login_creator() {
  need_cmd curl || return 1
  local email password
  email="${CREATOR_EMAIL:-$(env_value CREATOR_EMAIL)}"
  read -rp "Creator email [$email]: " input_email
  email="${input_email:-$email}"
  read -rsp "Creator password: " password
  echo
  [[ -n "$email" && -n "$password" ]] || { red "Email och password kravs."; return 1; }

  local cookie_file=".omerta-creator-cookie"
  local body
  body=$(printf '{"email":"%s","password":"%s"}' "$email" "$password")
  curl -fsS -c "$cookie_file" -H 'Content-Type: application/json' \
    -d "$body" "$API_URL/creator/login" >/dev/null
  chmod 600 "$cookie_file" 2>/dev/null || true
  green "Inloggad. Cookie sparad i $cookie_file."
}

api_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local cookie_file=".omerta-creator-cookie"
  [[ -f "$cookie_file" ]] || { red "Du maste logga in som creator forst."; return 1; }
  if [[ -n "$body" ]]; then
    curl -fsS -b "$cookie_file" -H 'Content-Type: application/json' -X "$method" -d "$body" "$API_URL$path"
  else
    curl -fsS -b "$cookie_file" -H 'Content-Type: application/json' -X "$method" "$API_URL$path"
  fi
}

show_status() {
  require_env || return 1
  green "Docker containers"
  compose ps
  echo
  green "Health"
  curl -fsS "$API_URL/health" || true
  echo
  curl -fsS "$API_URL/ready" || true
  echo
}

start_stack() {
  require_env || return 1
  compose up -d
  compose ps
}

build_restart_stack() {
  require_env || return 1
  compose build --no-cache --progress=plain
  compose up -d --force-recreate
  compose ps
}

restart_stack() {
  require_env || return 1
  compose restart
  compose ps
}

stop_stack() {
  require_env || return 1
  yellow "Stoppar containers men tar inte bort volymer/databas."
  compose down
}

show_logs() {
  require_env || return 1
  echo "1) Alla"
  echo "2) Server"
  echo "3) Dashboard"
  echo "4) Nginx"
  echo "5) Postgres"
  read -rp "Val: " choice
  case "$choice" in
    1) compose logs -f --tail=200 ;;
    2) compose logs -f --tail=200 omerta-core-server ;;
    3) compose logs -f --tail=200 omerta-creator-dashboard ;;
    4) compose logs -f --tail=200 nginx ;;
    5) compose logs -f --tail=200 omerta-postgres ;;
    *) red "Okant val." ;;
  esac
}

backup_db() {
  require_env || return 1
  chmod +x scripts/backup-db.sh 2>/dev/null || true
  scripts/backup-db.sh
}

restore_db() {
  require_env || return 1
  read -rp "Sokvag till .sql-backup: " backup_file
  [[ -f "$backup_file" ]] || { red "Filen finns inte."; return 1; }
  chmod +x scripts/restore-db.sh 2>/dev/null || true
  scripts/restore-db.sh "$backup_file"
}

reset_creator_password() {
  require_env || return 1
  local new_password
  new_password="$(random_secret)"
  set_env_value CREATOR_PASSWORD "$new_password"
  printf '%s\n' "$new_password" > creator-reset-password.txt
  chmod 600 creator-reset-password.txt 2>/dev/null || true
  green "Nytt creator-losenord sparat i creator-reset-password.txt."
  yellow "Startar om servern sa nya losenordet laddas."
  compose up -d --force-recreate omerta-core-server nginx
}

create_container() {
  read -rp "Container name [main]: " name
  name="${name:-main}"
  read -rp "Public API URL [$(env_value PUBLIC_API_URL)]: " api
  api="${api:-$(env_value PUBLIC_API_URL)}"
  read -rp "Public WS URL [$(env_value PUBLIC_WS_URL)]: " ws
  ws="${ws:-$(env_value PUBLIC_WS_URL)}"
  read -rp "Skapa forsta admin invite? [Y/n]: " create_admin
  create_admin="${create_admin:-Y}"
  local flag=false
  [[ "$create_admin" =~ ^[Yy]$ ]] && flag=true
  local body
  body=$(printf '{"name":"%s","apiUrl":"%s","wsUrl":"%s","createAdminInvite":%s}' "$name" "$api" "$ws" "$flag")
  api_json POST /creator/containers "$body"
  echo
}

create_invite() {
  local containers container_id role hours expires
  yellow "Hamtar containers..."
  containers="$(api_json GET /creator/containers)"
  echo "$containers"
  echo
  read -rp "Container id: " container_id
  read -rp "Role [ADMIN/SUB_ADMIN/USER] [ADMIN]: " role
  role="${role:-ADMIN}"
  read -rp "Giltig i antal timmar [72]: " hours
  hours="${hours:-72}"
  expires="$(date -u -d "+${hours} hours" '+%Y-%m-%dT%H:%M:%SZ')"
  local body
  body=$(printf '{"containerId":"%s","role":"%s","expiresAt":"%s"}' "$container_id" "$role" "$expires")
  api_json POST /creator/invites "$body"
  echo
}

install_wireguard() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y wireguard qrencode
  else
    red "Automatisk WireGuard-install stoder bara Debian/Ubuntu har."
    return 1
  fi
}

configure_wireguard() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || { red "WireGuard-konfig kraver root."; return 1; }
  need_cmd wg || install_wireguard
  need_cmd wg || return 1

  read -rp "VPS public IP/domain for VPN endpoint: " endpoint_host
  endpoint_host="${endpoint_host:-$(hostname -I | awk '{print $1}')}"
  read -rp "Client name [creator-phone]: " client_name
  client_name="${client_name:-creator-phone}"

  mkdir -p /etc/wireguard
  chmod 700 /etc/wireguard

  local server_private server_public client_private client_public client_ip config_path
  server_private="$(wg genkey)"
  server_public="$(printf '%s' "$server_private" | wg pubkey)"
  client_private="$(wg genkey)"
  client_public="$(printf '%s' "$client_private" | wg pubkey)"
  client_ip="10.8.0.2"
  config_path="/etc/wireguard/${client_name}.conf"

  cat >"/etc/wireguard/${WG_INTERFACE}.conf" <<EOF_WG
[Interface]
Address = ${WG_SERVER_IP}/24
ListenPort = ${WG_PORT}
PrivateKey = ${server_private}
PostUp = iptables -A INPUT -p udp --dport ${WG_PORT} -j ACCEPT
PostUp = iptables -A FORWARD -i ${WG_INTERFACE} -j ACCEPT
PostDown = iptables -D INPUT -p udp --dport ${WG_PORT} -j ACCEPT
PostDown = iptables -D FORWARD -i ${WG_INTERFACE} -j ACCEPT

[Peer]
PublicKey = ${client_public}
AllowedIPs = ${client_ip}/32
EOF_WG

  cat >"$config_path" <<EOF_CLIENT
[Interface]
PrivateKey = ${client_private}
Address = ${client_ip}/32
DNS = ${WG_CLIENT_DNS}

[Peer]
PublicKey = ${server_public}
Endpoint = ${endpoint_host}:${WG_PORT}
AllowedIPs = ${WG_SERVER_IP}/32
PersistentKeepalive = 25
EOF_CLIENT

  chmod 600 "/etc/wireguard/${WG_INTERFACE}.conf" "$config_path"
  systemctl enable --now "wg-quick@${WG_INTERFACE}"
  green "WireGuard ar startat pa ${WG_INTERFACE}."
  green "Client config: $config_path"
  if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ansiutf8 < "$config_path"
  fi
}

lock_dashboard_to_wireguard() {
  local nginx_conf="docker/nginx/omerta-vps-http.conf"
  [[ -f "$nginx_conf" ]] || { red "Hittar inte $nginx_conf."; return 1; }
  cp "$nginx_conf" "${nginx_conf}.bak.$(date +%Y%m%d%H%M%S)"
  if grep -q "allow ${WG_SUBNET};" "$nginx_conf"; then
    green "Nginx ar redan markerad for WireGuard allowlist."
  else
    sed -i "/location \\/ {/a\\    allow ${WG_SUBNET};\\n    deny all;" "$nginx_conf"
    green "Dashboard root-lasning till ${WG_SUBNET} inlagd i $nginx_conf."
  fi
  require_env || return 1
  compose up -d --force-recreate nginx
}

wireguard_menu() {
  echo
  echo "WireGuard / Dashboard"
  echo "1) Installera/konfigurera WireGuard server + creator-klient"
  echo "2) Las dashboarden till WireGuard-subnet i nginx"
  echo "3) Visa WireGuard status"
  echo "4) Tillbaka"
  read -rp "Val: " choice
  case "$choice" in
    1) configure_wireguard ;;
    2) lock_dashboard_to_wireguard ;;
    3) wg show ;;
    4) return 0 ;;
    *) red "Okant val." ;;
  esac
}

main_menu() {
  while true; do
    clear || true
    echo "OMERTA Server Control"
    echo "====================="
    echo "Root: $ROOT_DIR"
    echo "Compose: $COMPOSE_FILE"
    echo "API: $API_URL"
    echo
    echo "1) Status / health"
    echo "2) Starta containers"
    echo "3) Bygg om + starta om containers"
    echo "4) Starta om containers"
    echo "5) Stoppa containers"
    echo "6) Loggar"
    echo "7) Backup databas"
    echo "8) Restore databas"
    echo "9) Logga in som creator for API-kommandon"
    echo "10) Skapa container/workspace + valfri forsta admin invite"
    echo "11) Skapa ny invite/admin-kod"
    echo "12) Byt/resetta creator-losenord"
    echo "13) WireGuard + dashboard VPN"
    echo "14) Avsluta"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) show_status; pause ;;
      2) start_stack; pause ;;
      3) build_restart_stack; pause ;;
      4) restart_stack; pause ;;
      5) stop_stack; pause ;;
      6) show_logs ;;
      7) backup_db; pause ;;
      8) restore_db; pause ;;
      9) login_creator; pause ;;
      10) create_container; pause ;;
      11) create_invite; pause ;;
      12) reset_creator_password; pause ;;
      13) wireguard_menu; pause ;;
      14) exit 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

main_menu
