#!/usr/bin/env bash
# Actualiza el codigo, recompila, migra y reinicia el servicio systemd.
# Uso: npm run deploy
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

if [ -d .git ]; then
  echo "==> git pull"
  git pull --ff-only
fi

if [ ! -f .env ]; then
  echo "ERROR: falta .env. Corre primero: npm run vm:setup" >&2
  exit 1
fi

echo "==> npm install"
npm install --no-audit --no-fund

echo "==> npm run build"
npm run build

set -a
. ./.env
set +a

# Respaldo antes de tocar el esquema. Si falla, el deploy se detiene sin migrar.
# En el primer despliegue la base aun no existe y no hay nada que respaldar.
if [ -f "${DB_PATH:-./data/login.db}" ]; then
  echo "==> backup de la base"
  npm run db:backup
else
  echo "==> backup omitido: aun no existe ${DB_PATH:-./data/login.db}"
fi

echo "==> migraciones"
npm run db:migrate

if [ "${SKIP_HARDENING:-0}" != "1" ] && [ -f scripts/harden-server.sh ]; then
  echo "==> endurecimiento del servidor (scripts/harden-server.sh)"
  sudo -E bash scripts/harden-server.sh
else
  echo "==> endurecimiento del servidor omitido (SKIP_HARDENING=1 o falta scripts/harden-server.sh)"
fi

if systemctl list-unit-files 2>/dev/null | grep -q '^servicio-login\.service'; then
  echo "==> reiniciando servicio-login"
  sudo systemctl restart servicio-login
  sleep 1
  sudo systemctl --no-pager --lines=3 status servicio-login || true
else
  echo "Aviso: servicio-login.service no esta instalado. Corre: npm run vm:setup"
fi

IP_LOCAL="${PUBLIC_IP:-$(hostname -I | awk '{print $1}')}"
echo "==> health http://$IP_LOCAL:${PORT:-3000}/health"
curl -fsS --max-time 5 "http://127.0.0.1:${PORT:-3000}/health"
echo
