#!/usr/bin/env bash
# Instala la auto-actualizacion por polling de servicio-login:
#   * units systemd servicio-login-update.service y .timer, renderizadas desde
#     deploy/systemd/*.in reemplazando @USER@ y @REPO_DIR@.
#   * regla sudoers minima (NOPASSWD) para que el deploy pueda reiniciar y
#     consultar servicio-login sin contrasena.
#
# Uso:
#   sudo bash scripts/install-auto-update.sh              # instalar
#   sudo bash scripts/install-auto-update.sh --uninstall  # desinstalar
#
# Requiere root e idempotencia total. NO toca el firewall, SSH ni el servicio
# principal (servicio-login).
set -euo pipefail

UNIT_DIR="/etc/systemd/system"
SUDOERS_FILE="/etc/sudoers.d/servicio-login-update"
SERVICE_NAME="servicio-login-update.service"
TIMER_NAME="servicio-login-update.timer"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: este script necesita root. Uso: sudo bash scripts/install-auto-update.sh [--uninstall]" >&2
  exit 1
fi

MODE="install"
case "${1:-}" in
  --uninstall) MODE="uninstall" ;;
  "") ;;
  *)
    echo "ERROR: opcion no reconocida: $1 (usa --uninstall o nada)" >&2
    exit 1
    ;;
esac

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! SYSTEMCTL="$(command -v systemctl)"; then
  echo "ERROR: no encuentro systemctl; esto no parece un sistema con systemd" >&2
  exit 1
fi

if [ "$MODE" = "uninstall" ]; then
  systemctl disable --now "$TIMER_NAME" 2>/dev/null || true
  rm -f "$UNIT_DIR/$SERVICE_NAME" "$UNIT_DIR/$TIMER_NAME" "$SUDOERS_FILE"
  systemctl daemon-reload
  echo "==> auto-actualizacion desinstalada (units y regla sudoers eliminados)"
  echo "    el repo, la base y el servicio servicio-login no se tocaron"
  exit 0
fi

# --- Instalacion -------------------------------------------------------------

RUN_USER="${SUDO_USER:-}"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
  echo "ERROR: ejecuta con sudo desde el usuario dueno del repo." >&2
  echo "       El servicio corre como ese usuario, nunca como root." >&2
  exit 1
fi
if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "ERROR: el usuario '$RUN_USER' no existe en este sistema" >&2
  exit 1
fi

if ! VISUDO="$(command -v visudo)"; then
  echo "ERROR: no encuentro visudo (paquete sudo); no se instala nada" >&2
  exit 1
fi

SERVICE_TPL="$REPO_DIR/deploy/systemd/$SERVICE_NAME.in"
TIMER_TPL="$REPO_DIR/deploy/systemd/$TIMER_NAME.in"
if [ ! -f "$REPO_DIR/scripts/auto-update.sh" ] || [ ! -f "$SERVICE_TPL" ] || [ ! -f "$TIMER_TPL" ]; then
  echo "ERROR: no encuentro scripts/auto-update.sh o las plantillas en $REPO_DIR/deploy/systemd/" >&2
  exit 1
fi

if [ "$(stat -c %U "$REPO_DIR")" != "$RUN_USER" ]; then
  echo "AVISO: $REPO_DIR no es propiedad de $RUN_USER; revisa permisos si el deploy falla" >&2
fi

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

render() {
  sed -e "s|@USER@|$RUN_USER|g" -e "s|@REPO_DIR@|$REPO_DIR|g" "$1" > "$2"
}

render "$SERVICE_TPL" "$TMP_DIR/$SERVICE_NAME"
render "$TIMER_TPL" "$TMP_DIR/$TIMER_NAME"

if grep -qE '@(USER|REPO_DIR)@' "$TMP_DIR/$SERVICE_NAME" "$TMP_DIR/$TIMER_NAME"; then
  echo "ERROR: quedaron marcadores sin reemplazar en las plantillas; no se instala nada" >&2
  exit 1
fi

# Regla sudoers: SOLO reiniciar y consultar servicio-login, nada mas.
SUDOERS_TMP="$TMP_DIR/sudoers"
printf '%s ALL=(root) NOPASSWD: %s restart servicio-login, %s --no-pager --lines=3 status servicio-login\n' \
  "$RUN_USER" "$SYSTEMCTL" "$SYSTEMCTL" > "$SUDOERS_TMP"
chmod 0440 "$SUDOERS_TMP"
chown root:root "$SUDOERS_TMP"

# Validar ANTES de tocar el sistema: si la regla no es valida, no se instala nada.
if ! "$VISUDO" -cf "$SUDOERS_TMP" >/dev/null; then
  echo "ERROR: la regla sudoers generada no es valida; no se instalo nada" >&2
  exit 1
fi

install -m 0644 "$TMP_DIR/$SERVICE_NAME" "$UNIT_DIR/$SERVICE_NAME"
install -m 0644 "$TMP_DIR/$TIMER_NAME" "$UNIT_DIR/$TIMER_NAME"
install -m 0440 -o root -g root "$SUDOERS_TMP" "$SUDOERS_FILE"

systemctl daemon-reload
systemctl enable --now "$TIMER_NAME"

echo "==> instalado: $TIMER_NAME dispara scripts/auto-update.sh cada 5 minutos"
echo "==> unit:    $UNIT_DIR/$SERVICE_NAME"
echo "==> timer:   $UNIT_DIR/$TIMER_NAME"
echo "==> sudoers: $SUDOERS_FILE (solo restart/status de servicio-login)"
echo "==> el endurecimiento (scripts/harden-server.sh) queda manual; no corre aqui"
echo "==> estado:  systemctl list-timers $TIMER_NAME; journalctl -u $SERVICE_NAME -e"
