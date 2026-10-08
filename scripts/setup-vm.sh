#!/usr/bin/env bash
# Provisiona la VM de punta a punta (idempotente):
#   .env con secreto, dependencias, build, migraciones, systemd, firewall
#   y, si se pide, la IP secundaria persistente.
#
# Uso:
#   npm run vm:setup
#   IP_CIDR=192.168.102.91/24 IFACE=ens18 npm run vm:setup
#   SEED_PASSWORD='Demo!Passw0rd123' npm run vm:setup
#
# Recomendado ejecutarlo como tu usuario normal (usa sudo internamente para
# systemd, ufw y la IP).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

TARGET_USER="${SUDO_USER:-$(id -un)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
PORT="${PORT:-3000}"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Ejecuta npm como el usuario dueno del repo cuando el script corre con sudo.
run_npm() {
  if [ "$(id -u)" -eq 0 ] && [ "$TARGET_USER" != "root" ]; then
    sudo -u "$TARGET_USER" -H bash -lc "cd '$REPO_DIR' && set -a && . ./.env && set +a && npm $*"
  else
    npm "$@"
  fi
}

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node no esta en PATH." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: se requiere Node >= 20.6 (tienes $("$NODE_BIN" -v))." >&2
  exit 1
fi
echo "==> Node $("$NODE_BIN" -v) en $NODE_BIN"

echo "==> .env"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Creado .env desde .env.example"
fi
if ! grep -q '^JWT_SECRET=' .env || grep -q 'CHANGE_ME' .env; then
  SECRET="$(openssl rand -hex 32)"
  if grep -q '^JWT_SECRET=' .env; then
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" .env
  else
    printf '\nJWT_SECRET=%s\n' "$SECRET" >>.env
  fi
  echo "JWT_SECRET generado (32 bytes hex)"
fi

echo "==> npm install"
run_npm install --no-audit --no-fund

echo "==> npm run build"
run_npm run build

set -a
. ./.env
set +a

echo "==> migraciones"
run_npm run db:migrate

if [ -n "${SEED_PASSWORD:-}" ]; then
  echo "==> seed (demo@example.com)"
  SEED_PASSWORD="$SEED_PASSWORD" run_npm run db:seed
fi

if command -v ufw >/dev/null 2>&1 && as_root ufw status 2>/dev/null | grep -q "Status: active"; then
  echo "==> ufw allow ${PORT}/tcp"
  as_root ufw allow "${PORT}/tcp" >/dev/null
fi

echo "==> systemd (servicio-login.service)"
TMP_UNIT="$(mktemp)"
cat >"$TMP_UNIT" <<EOF
[Unit]
Description=servicio-login API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TARGET_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env
Environment=NODE_ENV=production
ExecStart=$NODE_BIN dist/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
as_root install -m 0644 "$TMP_UNIT" /etc/systemd/system/servicio-login.service
rm -f "$TMP_UNIT"
as_root systemctl daemon-reload
as_root systemctl enable --now servicio-login >/dev/null
as_root systemctl restart servicio-login

if [ -n "${IP_CIDR:-}" ]; then
  echo "==> IP secundaria persistente"
  IP_CIDR="$IP_CIDR" IFACE="${IFACE:-}" bash "$REPO_DIR/scripts/persist-ip.sh"
fi

sleep 1
IP_LOCAL="${PUBLIC_IP:-$(hostname -I | awk '{print $1}')}"
echo
echo "==> Estado del servicio"
as_root systemctl --no-pager --lines=3 status servicio-login || true
echo
echo "Frontend: http://$IP_LOCAL:$PORT/"
echo "Swagger:  http://$IP_LOCAL:$PORT/docs"
if [ -n "${IP_CIDR:-}" ]; then
  echo "IP extra: http://${IP_CIDR%%/*}:$PORT/"
fi
