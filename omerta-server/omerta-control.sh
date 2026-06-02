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
blue() { printf '\033[0;36m%s\033[0m\n' "$*"; }
muted() { printf '\033[2m%s\033[0m\n' "$*"; }
pause() { echo; read -rp "Tryck Enter for att fortsatta..." _; }

line() {
  printf '%s\n' "------------------------------------------------------------"
}

screen() {
  clear || true
  blue "OMERTA Control Center"
  line
  printf 'Root:    %s\n' "$ROOT_DIR"
  printf 'Compose: %s\n' "$COMPOSE_FILE"
  printf 'API:     %s\n' "$API_URL"
  if [[ -f "$ENV_FILE" ]]; then
    green "Env:     $ENV_FILE"
  else
    yellow "Env:     $ENV_FILE saknas"
  fi
  line
}

section() {
  echo
  blue "$1"
  line
}

option() {
  printf '  %2s) %s\n' "$1" "$2"
}

confirm() {
  local prompt="$1"
  local answer
  read -rp "$prompt [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

quick_status() {
  if [[ ! -f "$ENV_FILE" ]] || ! command -v docker >/dev/null 2>&1; then
    muted "Snabbstatus: ej tillganglig innan Docker/.env finns."
    return 0
  fi
  local running total
  running="$(compose ps --status running --services 2>/dev/null | wc -l | tr -d ' ')"
  total="$(compose ps --services 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${running:-0}" -gt 0 ]]; then
    green "Snabbstatus: $running/$total services running"
  else
    yellow "Snabbstatus: inga services verkar vara igang"
  fi
}

show_readiness() {
  local ok=true
  if command -v docker >/dev/null 2>&1; then
    green "[ok] Docker finns"
  else
    yellow "[!] Docker saknas eller finns inte i PATH"
    ok=false
  fi
  if [[ -f "$ENV_FILE" ]]; then
    green "[ok] $ENV_FILE finns"
  else
    yellow "[!] $ENV_FILE saknas"
    ok=false
  fi
  if [[ -f "$COMPOSE_FILE" ]]; then
    green "[ok] $COMPOSE_FILE finns"
  else
    red "[x] $COMPOSE_FILE saknas"
    ok=false
  fi
  if [[ "$ok" == false ]]; then
    echo
    muted "Ny VPS? Kor forst:"
    echo "  chmod +x deploy-server-dashboard.sh omerta-control.sh"
    echo "  ./deploy-server-dashboard.sh"
  fi
}

run_action() {
  local title="$1"
  shift
  screen
  section "$title"
  "$@"
  pause
}

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
  while true; do
    screen
    section "Secure access"
    option 1 "Installera/konfigurera WireGuard server + creator-klient"
    option 2 "Las dashboarden till WireGuard-subnet i nginx"
    option 3 "Visa WireGuard status"
    option 0 "Tillbaka"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) run_action "WireGuard setup" configure_wireguard ;;
      2) run_action "Dashboard VPN lock" lock_dashboard_to_wireguard ;;
      3) run_action "WireGuard status" wg show ;;
      0) return 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

stack_menu() {
  while true; do
    screen
    quick_status
    section "Stack och containers"
    option 1 "Status / health"
    option 2 "Starta containers"
    option 3 "Starta om containers"
    option 4 "Bygg om + starta om containers"
    option 5 "Stoppa containers"
    option 6 "Loggar"
    option 0 "Tillbaka"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) run_action "Status / health" show_status ;;
      2) run_action "Starta containers" start_stack ;;
      3) run_action "Starta om containers" restart_stack ;;
      4)
        if confirm "Bygga om alla images kan ta ett par minuter. Fortsatt?"; then
          run_action "Bygg om + starta om" build_restart_stack
        fi
        ;;
      5)
        if confirm "Stoppa containers? Databasvolymer behalls."; then
          run_action "Stoppa containers" stop_stack
        fi
        ;;
      6) show_logs ;;
      0) return 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

access_menu() {
  while true; do
    screen
    section "Creator access"
    option 1 "Logga in som creator for API-kommandon"
    option 2 "Byt/resetta creator-losenord"
    option 3 "Visa aktiv API och creator email"
    option 0 "Tillbaka"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) run_action "Creator login" login_creator ;;
      2)
        if confirm "Resetta creator-losenord och starta om servern?"; then
          run_action "Reset creator password" reset_creator_password
        fi
        ;;
      3)
        screen
        section "Aktiv konfiguration"
        printf 'API_URL:        %s\n' "$API_URL"
        printf 'CREATOR_EMAIL:  %s\n' "$(env_value CREATOR_EMAIL)"
        printf 'PUBLIC_API_URL: %s\n' "$(env_value PUBLIC_API_URL)"
        printf 'PUBLIC_WS_URL:  %s\n' "$(env_value PUBLIC_WS_URL)"
        pause
        ;;
      0) return 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

workspace_menu() {
  while true; do
    screen
    section "Workspaces och invites"
    muted "Tips: logga in som creator innan du skapar containers eller invites."
    option 1 "Skapa container/workspace + valfri forsta admin invite"
    option 2 "Skapa ny invite/admin-kod"
    option 3 "Lista containers"
    option 4 "Lista invites"
    option 0 "Tillbaka"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) run_action "Skapa workspace" create_container ;;
      2) run_action "Skapa invite" create_invite ;;
      3) run_action "Containers" api_json GET /creator/containers ;;
      4) run_action "Invites" api_json GET /creator/invites ;;
      0) return 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

backup_menu() {
  while true; do
    screen
    section "Backup och restore"
    option 1 "Backup databas"
    option 2 "Restore databas fran .sql-backup"
    option 0 "Tillbaka"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) run_action "Backup databas" backup_db ;;
      2)
        if confirm "Restore skriver tillbaka en backup till databasen. Fortsatt?"; then
          run_action "Restore databas" restore_db
        fi
        ;;
      0) return 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

security_menu() {
  while true; do
    screen
    section "Security operations"
    option 1 "WireGuard + dashboard VPN"
    option 2 "Visa audit-loggar"
    option 3 "Visa release policy"
    option 4 "Visa wipe commands"
    option 0 "Tillbaka"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) wireguard_menu ;;
      2) run_action "Audit logs" api_json GET /creator/audit-logs ;;
      3) run_action "Release policy" api_json GET /release/policy ;;
      4) run_action "Wipe commands" api_json GET /creator/wipe/commands ;;
      0) return 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

main_menu() {
  while true; do
    screen
    quick_status
    show_readiness
    section "Huvudmeny"
    option 1 "Stack och containers"
    option 2 "Creator access"
    option 3 "Workspaces och invites"
    option 4 "Security operations"
    option 5 "Backup och restore"
    option 6 "Snabbstatus / health"
    option 0 "Avsluta"
    echo
    read -rp "Val: " choice
    case "$choice" in
      1) stack_menu ;;
      2) access_menu ;;
      3) workspace_menu ;;
      4) security_menu ;;
      5) backup_menu ;;
      6) run_action "Status / health" show_status ;;
      0) exit 0 ;;
      *) red "Okant val."; pause ;;
    esac
  done
}

main_menu
