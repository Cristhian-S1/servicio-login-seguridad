#!/usr/bin/env bash
# Instala (o desinstala con --uninstall) el ciclo de telemetria de
# servicio-login: recoleccion local + publicacion en un repositorio PRIVADO
# separado.
#
# Requiere root (escribe en /etc y /var/lib, y gestiona systemd):
#   sudo bash scripts/install-telemetry.sh
#   sudo bash scripts/install-telemetry.sh --uninstall
#
# Nunca genera ni sube claves: al terminar imprime las instrucciones para
# crear el repo privado, la deploy key y rellenar telemetry.env.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="/etc/systemd/system"
SERVICE_UNIT="servicio-login-telemetry.service"
TIMER_UNIT="servicio-login-telemetry.timer"
SERVICE_SRC="$REPO_DIR/deploy/systemd/$SERVICE_UNIT.in"
TIMER_SRC="$REPO_DIR/deploy/systemd/$TIMER_UNIT.in"
STATE_DIR="/var/lib/servicio-login"
CONF_DIR="/etc/servicio-login"
CONF_FILE="$CONF_DIR/telemetry.env"
ENV_EXAMPLE="$REPO_DIR/deploy/telemetry.env.example"
KEY_FILE="$STATE_DIR/telemetry_key"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  die "este script debe ejecutarse como root (usa: sudo bash scripts/install-telemetry.sh)"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  die "systemd no esta disponible en este sistema"
fi

UNINSTALL=0
case "${1:-}" in
  --uninstall) UNINSTALL=1 ;;
  "") ;;
  *) die "uso: bash scripts/install-telemetry.sh [--uninstall]" ;;
esac

if [ "$UNINSTALL" -eq 1 ]; then
  log "deteniendo y deshabilitando el timer de telemetria"
  systemctl disable --now "$TIMER_UNIT" >/dev/null 2>&1 || true
  systemctl stop "$SERVICE_UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$SERVICE_UNIT" "$UNIT_DIR/$TIMER_UNIT"
  systemctl daemon-reload
  log "telemetria desinstalada"
  echo
  echo "Se conservan a proposito (borralos a mano si ya no los quieres):"
  echo "  - $CONF_FILE (configuracion, con permisos 0600)"
  echo "  - $STATE_DIR (deploy key, known_hosts y copia del repo de telemetria)"
  exit 0
fi

[ -f "$SERVICE_SRC" ] || die "falta la plantilla $SERVICE_SRC"
[ -f "$TIMER_SRC" ] || die "falta la plantilla $TIMER_SRC"
[ -f "$ENV_EXAMPLE" ] || die "falta $ENV_EXAMPLE"

# systemd no hereda el PATH del shell: si node viene de nvm hay que fijarlo en
# la unit. Se deduce del servicio principal, o de la nvm del usuario de la app.
NODE_DIR=""
if NODE_BIN="$(command -v node 2>/dev/null)"; then
  NODE_DIR="$(dirname "$NODE_BIN")"
fi
if [ -z "$NODE_DIR" ]; then
  APP_EXEC="$(systemctl cat servicio-login.service 2>/dev/null | awk -F'=' '/^ExecStart=/{print $2; exit}')"
  APP_NODE="${APP_EXEC%% *}"
  if [ -n "$APP_NODE" ] && [ -x "$APP_NODE" ]; then
    NODE_DIR="$(dirname "$APP_NODE")"
  fi
fi
if [ -z "$NODE_DIR" ] && [ -n "${SUDO_USER:-}" ] && [ -d "/home/$SUDO_USER/.nvm/versions/node" ]; then
  for candidate in /home/"$SUDO_USER"/.nvm/versions/node/*/bin; do
    if [ -x "$candidate/node" ]; then NODE_DIR="$candidate"; fi
  done
fi
if [ -z "$NODE_DIR" ]; then
  NODE_DIR="/usr/local/bin"
  echo "AVISO: no encontre node; la telemetria no podra recolectar ni publicar. Define PATH en $CONF_FILE." >&2
else
  log "node para el servicio de telemetria: $NODE_DIR"
fi

log "creando $STATE_DIR (0700)"
install -d -m 0700 "$STATE_DIR"

log "creando $CONF_DIR (0700)"
install -d -m 0700 "$CONF_DIR"
if [ ! -f "$CONF_FILE" ]; then
  install -m 0600 "$ENV_EXAMPLE" "$CONF_FILE"
  log "creado $CONF_FILE desde deploy/telemetry.env.example (0600): editalo para activar la publicacion"
else
  log "$CONF_FILE ya existe; no se toca"
fi

# Renderiza @REPO_DIR@ en la plantilla y escribe el destino solo si cambia
# (reinstalar no debe provocar daemon-reload innecesario).
render_template() {
  local src="$1" dst="$2" tmp content
  tmp="$(mktemp)"
  content="$(<"$src")"
  content="${content//@REPO_DIR@/$REPO_DIR}"
  content="${content//@NODE_DIR@/$NODE_DIR}"
  printf '%s\n' "$content" >"$tmp"
  if [ -f "$dst" ] && cmp -s "$tmp" "$dst"; then
    printf 'sin cambios: %s\n' "$dst"
  else
    install -m 0644 "$tmp" "$dst"
    printf 'escrito: %s\n' "$dst"
  fi
  rm -f "$tmp"
}

# El servicio corre como root, asi que NO puede ejecutar scripts del repo
# (los escribe el usuario de la app, que ademas recibe codigo por auto-update).
# Se instalan copias propiedad de root; vuelve a correr este instalador tras
# actualizar estos dos scripts para refrescarlas.
SCRIPTS_DST="/usr/local/lib/servicio-login-telemetry"
log "instalando copias propiedad de root en $SCRIPTS_DST"
install -d -m 0755 -o root -g root "$SCRIPTS_DST"
for script in collect-metrics.sh publish-telemetry.sh; do
  [ -f "$REPO_DIR/scripts/$script" ] || die "falta scripts/$script"
  install -m 0755 -o root -g root "$REPO_DIR/scripts/$script" "$SCRIPTS_DST/$script"
done

log "instalando unidades systemd"
render_template "$SERVICE_SRC" "$UNIT_DIR/$SERVICE_UNIT"
render_template "$TIMER_SRC" "$UNIT_DIR/$TIMER_UNIT"

systemctl daemon-reload
systemctl enable --now "$TIMER_UNIT" >/dev/null
if ! systemctl is-active --quiet "$TIMER_UNIT"; then
  die "el timer $TIMER_UNIT no quedo activo; revisa: systemctl status $TIMER_UNIT"
fi
log "timer habilitado: $TIMER_UNIT (cada 15 min)"

echo
echo "====================================================================="
echo "Puesta en marcha (una sola vez):"
echo
echo "1. Crea un repositorio PRIVADO en GitHub, por ejemplo:"
echo "     <tu-usuario>/servicio-login-telemetria"
echo "   No lo hagas publico: publish-telemetry.sh se niega a publicar en un"
echo "   repo publico (la guarda consulta la API de GitHub sin token)."
echo
echo "2. Genera la deploy key DEDICADA a ese repo (nunca la compartas):"
echo "     sudo ssh-keygen -t ed25519 -f $KEY_FILE -N \"\""
echo
echo "3. En GitHub -> repo de telemetria -> Settings -> Deploy keys ->"
echo "   Add deploy key: pega el contenido de $KEY_FILE.pub y marca"
echo "   'Allow write access' (esa clave solo debe existir en ESE repo)."
echo
echo "4. Edita $CONF_FILE y define TELEMETRY_REPO, por ejemplo:"
echo "     TELEMETRY_REPO=git@github.com:<tu-usuario>/servicio-login-telemetria.git"
echo "   (TELEMETRY_SSH_KEY y TELEMETRY_DIR ya coinciden con los valores por defecto)."
echo
echo "5. Lanza el primer ciclo ahora mismo:"
echo "     sudo systemctl start $SERVICE_UNIT"
echo
echo "6. Comprueba el resultado:"
echo "     systemctl list-timers $TIMER_UNIT"
echo "     journalctl -u $SERVICE_UNIT -e --no-pager"
echo "     y abre STATUS.md en el repo privado de GitHub."
echo "====================================================================="
