#!/usr/bin/env bash
set -euo pipefail

API_URL=""
CREATOR_EMAIL=""
INSTALL_DOCKER="false"
COMPOSE_FILE="docker-compose.vps.yml"

usage() {
  cat <<EOF
Omerta quick deploy

Usage:
  ./quick-deploy-fixed.sh --api-url http://YOUR_VPS_IP --creator-email you@example.com [--install-docker]

Options:
  --api-url          Public API URL, for example http://1.2.3.4 or https://api.example.com
  --creator-email    Creator/admin email used by bootstrap env
  --install-docker   Install Docker + Compose plugin on Ubuntu/Debian
  -h, --help         Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url)
      API_URL="${2:-}"; shift 2 ;;
    --creator-email)
      CREATOR_EMAIL="${2:-}"; shift 2 ;;
    --install-docker)
      INSTALL_DOCKER="true"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$API_URL" ]]; then
  echo "Missing --api-url" >&2
  usage
  exit 1
fi

if [[ -z "$CREATOR_EMAIL" ]]; then
  echo "Missing --creator-email" >&2
  usage
  exit 1
fi

# Find project root robustly.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CWD="$(pwd)"
PROJECT_ROOT=""

if [[ -f "$CWD/$COMPOSE_FILE" ]]; then
  PROJECT_ROOT="$CWD"
elif [[ -f "$SCRIPT_DIR/$COMPOSE_FILE" ]]; then
  PROJECT_ROOT="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/../$COMPOSE_FILE" ]]; then
  PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  echo "Could not find $COMPOSE_FILE." >&2
  echo "Run this from the Omerta project root, or place this script in the same folder as $COMPOSE_FILE." >&2
  echo "Current dir: $CWD" >&2
  echo "Script dir:  $SCRIPT_DIR" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
echo "Using project root: $PROJECT_ROOT"

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "Docker + Compose already installed."
    return
  fi

  if [[ "$EUID" -ne 0 ]]; then
    echo "Docker install requires root. Re-run with sudo/root or omit --install-docker." >&2
    exit 1
  fi

  echo "Installing Docker + Compose plugin..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg lsb-release
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg || true
  chmod a+r /etc/apt/keyrings/docker.gpg || true

  if [[ -r /etc/os-release ]]; then
    . /etc/os-release
  fi

  DISTRO_ID="${ID:-ubuntu}"
  DISTRO_CODENAME="${VERSION_CODENAME:-$(lsb_release -cs 2>/dev/null || echo jammy)}"

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO_ID} ${DISTRO_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update || {
    echo "Docker repo failed, falling back to distro docker packages..."
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker.io docker-compose-plugin
    systemctl enable --now docker || true
    return
  }
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker || true
}

if [[ "$INSTALL_DOCKER" == "true" ]]; then
  install_docker
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Re-run with --install-docker or install Docker manually." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is not installed. Re-run with --install-docker or install docker-compose-plugin." >&2
  exit 1
fi

if [[ ! -f ".env" ]]; then
  if [[ -f ".env.vps.example" ]]; then
    cp .env.vps.example .env
    echo "Created .env from .env.vps.example"
  else
    touch .env
    echo "Created empty .env"
  fi
else
  echo ".env already exists; keeping existing file and updating required values."
fi

rand_hex() {
  openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

set_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

# URL settings used by server/dashboard/app config templates.
set_env "PUBLIC_API_URL" "$API_URL"
set_env "API_URL" "$API_URL"
set_env "VITE_API_URL" "$API_URL"
set_env "CREATOR_EMAIL" "$CREATOR_EMAIL"

# Generate common secrets if missing/placeholder.
ensure_secret() {
  local key="$1"
  if ! grep -qE "^${key}=.{24,}" .env || grep -qE "^${key}=(change-me|changeme|replace-me|dev|secret)" .env; then
    set_env "$key" "$(rand_hex)"
  fi
}

ensure_secret "JWT_SECRET"
ensure_secret "REFRESH_TOKEN_SECRET"
ensure_secret "COOKIE_SECRET"
ensure_secret "SESSION_SECRET"
ensure_secret "CREATOR_BOOTSTRAP_PASSWORD"

mkdir -p logs backups certs

CREATOR_PASS="$(grep '^CREATOR_BOOTSTRAP_PASSWORD=' .env | tail -n1 | cut -d= -f2-)"
printf '%s\n' "$CREATOR_PASS" > creator-password.txt
chmod 600 creator-password.txt || true

echo "Validating compose file..."
docker compose -f "$COMPOSE_FILE" config >/dev/null

echo "Starting Omerta VPS stack..."
docker compose -f "$COMPOSE_FILE" up -d --build

echo "Waiting for API to become available..."
for i in $(seq 1 40); do
  if curl -fsS "$API_URL/health" >/dev/null 2>&1 || curl -fsS "http://127.0.0.1/health" >/dev/null 2>&1; then
    echo "Health check OK."
    break
  fi
  sleep 3
  if [[ "$i" -eq 40 ]]; then
    echo "Health check did not pass yet. Showing logs:" >&2
    docker compose -f "$COMPOSE_FILE" ps
    docker compose -f "$COMPOSE_FILE" logs --tail=120
    exit 1
  fi
done

echo ""
echo "Omerta deploy finished."
echo "API URL: $API_URL"
echo "Creator email: $CREATOR_EMAIL"
echo "Creator password saved in: $PROJECT_ROOT/creator-password.txt"
echo "Useful commands:"
echo "  docker compose -f $COMPOSE_FILE ps"
echo "  docker compose -f $COMPOSE_FILE logs -f"
echo "  docker compose -f $COMPOSE_FILE down"
