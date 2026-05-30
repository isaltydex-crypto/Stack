#!/usr/bin/env bash
set -euo pipefail

API_URL=""
CREATOR_EMAIL=""
INSTALL_DOCKER="false"
RESET_ENV="false"
ASSUME_YES="false"
COMPOSE_FILE="docker-compose.vps.yml"

usage() {
  cat <<USAGE
Omerta server + dashboard deploy

Usage:
  ./deploy-server-dashboard.sh
  ./deploy-server-dashboard.sh --api-url http://YOUR_VPS_IP --creator-email you@example.com [--install-docker] [--reset-env]

Options:
  --api-url          Public API URL, e.g. http://1.2.3.4 or https://api.example.com
  --creator-email    Creator email for initial account/config
  --install-docker   Install Docker + Docker Compose plugin on Ubuntu/Debian
  --reset-env        Recreate .env and new secrets even if .env exists
  --yes, -y          Accept default answers for prompts
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --creator-email) CREATOR_EMAIL="${2:-}"; shift 2 ;;
    --install-docker) INSTALL_DOCKER="true"; shift ;;
    --reset-env) RESET_ENV="true"; shift ;;
    --yes|-y) ASSUME_YES="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1"; usage; exit 1 ;;
  esac
done

[[ -f "$COMPOSE_FILE" ]] || { echo "$COMPOSE_FILE not found. Run this from the extracted Omerta server package root."; exit 1; }

prompt_value() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local value="${!var_name:-}"
  if [[ -n "$value" ]]; then
    return
  fi
  while [[ -z "$value" ]]; do
    if [[ -n "$default_value" ]]; then
      read -rp "$label [$default_value]: " value
      value="${value:-$default_value}"
    else
      read -rp "$label: " value
    fi
  done
  printf -v "$var_name" '%s' "$value"
}

prompt_yes_no() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-false}"
  local current_value="${!var_name:-}"
  local default_label="n"
  [[ "$default_value" == "true" ]] && default_label="Y"

  if [[ "$current_value" == "true" || "$current_value" == "false" ]]; then
    return
  fi
  if [[ "$ASSUME_YES" == "true" ]]; then
    printf -v "$var_name" '%s' "$default_value"
    return
  fi

  while true; do
    read -rp "$label [$default_label]: " answer
    answer="${answer:-$default_label}"
    case "$answer" in
      y|Y|yes|YES|Yes) printf -v "$var_name" 'true'; return ;;
      n|N|no|NO|No) printf -v "$var_name" 'false'; return ;;
      *) echo "Svar y eller n." ;;
    esac
  done
}

detect_public_ip() {
  hostname -I 2>/dev/null | awk '{print $1}' || true
}

echo "Omerta server + dashboard deploy"
echo "================================"
echo

DEFAULT_IP="$(detect_public_ip)"
DEFAULT_API_URL=""
[[ -n "$DEFAULT_IP" ]] && DEFAULT_API_URL="http://$DEFAULT_IP"
prompt_value API_URL "VPS API URL, t.ex. http://DIN_VPS_IP" "$DEFAULT_API_URL"
prompt_value CREATOR_EMAIL "Creator email" "creator@omerta.local"

if [[ "$INSTALL_DOCKER" != "true" ]]; then
  INSTALL_DOCKER_PROMPT="ask"
  prompt_yes_no INSTALL_DOCKER_PROMPT "Installera Docker automatiskt om det saknas?" "true"
  INSTALL_DOCKER="$INSTALL_DOCKER_PROMPT"
fi

if [[ -f .env && "$RESET_ENV" != "true" ]]; then
  RESET_ENV_PROMPT="ask"
  prompt_yes_no RESET_ENV_PROMPT ".env finns redan. Skapa nya secrets och nytt creator-losenord?" "false"
  RESET_ENV="$RESET_ENV_PROMPT"
fi

echo
echo "Deploy config:"
echo "  API URL:        $API_URL"
echo "  Creator email:  $CREATOR_EMAIL"
echo "  Install Docker: $INSTALL_DOCKER"
echo "  Reset .env:     $RESET_ENV"
echo
if [[ "$ASSUME_YES" != "true" ]]; then
  CONFIRM_DEPLOY="ask"
  prompt_yes_no CONFIRM_DEPLOY "Fortsatt deploy med dessa val?" "true"
  [[ "$CONFIRM_DEPLOY" == "true" ]] || { echo "Avbrutet."; exit 0; }
fi

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "[OK] Docker already installed"
    return
  fi
  echo "[1/6] Installing Docker..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  if [[ "${ID:-}" == "ubuntu" ]]; then
    REPO_OS="ubuntu"
  else
    REPO_OS="debian"
  fi
  curl -fsSL "https://download.docker.com/linux/${REPO_OS}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${REPO_OS} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    tr -dc 'a-f0-9' </dev/urandom | head -c 64
  fi
}

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|g" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

if [[ "$INSTALL_DOCKER" == "true" ]]; then
  install_docker
else
  echo "[1/6] Skipping Docker install"
fi

echo "[2/6] Preparing .env..."
if [[ ! -f .env || "$RESET_ENV" == "true" ]]; then
  if [[ -f .env.vps.example ]]; then
    cp .env.vps.example .env
  else
    touch .env
  fi
  DB_PASSWORD="$(gen_secret)"
  CREATOR_PASSWORD="$(gen_secret)"
  set_env "NODE_ENV" "production"
  set_env "PUBLIC_API_URL" "$API_URL"
  if [[ "$API_URL" == https://* ]]; then
    WS_URL="${API_URL/https:\/\//wss://}/ws"
  else
    WS_URL="${API_URL/http:\/\//ws://}/ws"
  fi
  set_env "PUBLIC_WS_URL" "$WS_URL"
  set_env "DASHBOARD_ORIGIN" "$API_URL"
  set_env "VITE_API_URL" "$API_URL"
  set_env "CREATOR_EMAIL" "$CREATOR_EMAIL"
  set_env "CREATOR_PASSWORD" "$CREATOR_PASSWORD"
  set_env "JWT_SECRET" "$(gen_secret)"
  set_env "COOKIE_SECRET" "$(gen_secret)"
  set_env "POSTGRES_PASSWORD" "$DB_PASSWORD"
  set_env "DATABASE_URL" "postgres://omerta:${DB_PASSWORD}@omerta-postgres:5432/omerta"
  echo "$CREATOR_PASSWORD" > creator-initial-password.txt
  chmod 600 creator-initial-password.txt
else
  echo "[OK] Existing .env kept. Use --reset-env to recreate it."
fi

echo "[3/6] Stopping old containers..."
docker compose -f "$COMPOSE_FILE" down || true

echo "[4/6] Building containers..."
docker compose -f "$COMPOSE_FILE" build --no-cache --progress=plain

echo "[5/6] Starting containers..."
docker compose -f "$COMPOSE_FILE" up -d

echo "[6/6] Status:"
docker compose -f "$COMPOSE_FILE" ps

echo
echo "Deploy complete."
echo "API URL: $API_URL"
echo "Creator email: $CREATOR_EMAIL"
[[ -f creator-initial-password.txt ]] && echo "Creator initial password: $(pwd)/creator-initial-password.txt"
echo
echo "Logs: docker compose -f $COMPOSE_FILE logs -f"


