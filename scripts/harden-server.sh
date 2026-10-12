#!/usr/bin/env bash
# Endurecimiento del servidor (idempotente, requiere root):
#   paquetes minimos, UFW, SSH, fail2ban, sysctl, actualizaciones de
#   seguridad automaticas y aislamiento systemd de servicio-login.
#
# Lo invoca scripts/deploy.sh antes de reiniciar el servicio; se puede saltar
# con SKIP_HARDENING=1.
#
# Uso manual:
#   sudo -E bash scripts/harden-server.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

APP_PORT="${PORT:-3000}"
# sshd usa el PRIMER valor que encuentra y lee sshd_config.d en orden
# alfabetico: el prefijo 00- gana frente a 50-cloud-init.conf y similares.
SSH_CONF="/etc/ssh/sshd_config.d/00-hardening.conf"
SSH_CONF_LEGACY="/etc/ssh/sshd_config.d/99-hardening.conf"
FAIL2BAN_CONF="/etc/fail2ban/jail.d/hardening.local"
SYSCTL_CONF="/etc/sysctl.d/99-hardening.conf"
AUTO_UPGRADES_CONF="/etc/apt/apt.conf.d/20auto-upgrades"
SERVICE_UNIT="servicio-login.service"
SERVICE_DROPIN="/etc/systemd/system/${SERVICE_UNIT}.d/hardening.conf"

# Directorio de la base: sigue a DB_PATH (relativo al repo, como la app) para
# que ReadWritePaths coincida con lo que el servicio realmente escribe.
DB_FILE="${DB_PATH:-./data/login.db}"
case "$DB_FILE" in
  :memory:*) DB_FILE="./data/login.db" ;;
esac
case "$DB_FILE" in
  /*) ;;
  *) DB_FILE="$REPO_DIR/${DB_FILE#./}" ;;
esac
DATA_DIR="$(dirname "$DB_FILE")"

APLICADO=()
OMITIDO=()

log() { printf '==> %s\n' "$*"; }
warn() { printf 'AVISO: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  die "este script debe ejecutarse como root (usa: sudo -E bash scripts/harden-server.sh)"
fi

# Escribe $target solo si el contenido cambia. Deja WRITE_CHANGED=1/0 y
# registra el resultado en el resumen final.
WRITE_CHANGED=0
write_if_changed() {
  local target="$1" label="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
    WRITE_CHANGED=0
    OMITIDO+=("$label: $target (sin cambios)")
  else
    WRITE_CHANGED=1
    install -D -m 0644 -o root -g root "$tmp" "$target"
    APLICADO+=("$label: $target")
  fi
  rm -f "$tmp"
}

# --- Paquetes ---------------------------------------------------------
FALTANTES=()
for pkg in ufw fail2ban unattended-upgrades; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    FALTANTES+=("$pkg")
  fi
done

if [ "${#FALTANTES[@]}" -gt 0 ]; then
  log "instalando paquetes faltantes: ${FALTANTES[*]}"
  apt-get update -qq
  # El timeout evita fallar si apt-daily tiene el lock tomado.
  DEBIAN_FRONTEND=noninteractive apt-get install -y -o DPkg::Lock::Timeout=120 "${FALTANTES[@]}"
  APLICADO+=("paquetes: ${FALTANTES[*]}")
else
  OMITIDO+=("paquetes (ufw, fail2ban, unattended-upgrades): ya instalados")
fi

# --- UFW --------------------------------------------------------------
SSH_PORTS=()
if command -v sshd >/dev/null 2>&1; then
  mapfile -t SSH_PORTS < <(sshd -T 2>/dev/null | awk '/^port /{print $2}')
fi
if [ "${#SSH_PORTS[@]}" -eq 0 ]; then
  SSH_PORTS=(22)
fi

UFW_ACTIVO="no"
if ufw status 2>/dev/null | grep -q "Status: active"; then
  UFW_ACTIVO="si"
fi

log "ufw: deny incoming + allow outgoing; SSH ${SSH_PORTS[*]}/tcp y app ${APP_PORT}/tcp"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for ssh_port in "${SSH_PORTS[@]}"; do
  ufw allow "${ssh_port}/tcp" comment "SSH" >/dev/null
done
ufw allow "${APP_PORT}/tcp" comment "servicio-login" >/dev/null
# Las reglas de SSH y de la app ya estan puestas: recien ahora se habilita ufw.
ufw --force enable >/dev/null
if [ "$UFW_ACTIVO" = "si" ]; then
  APLICADO+=("ufw: ya estaba activo; reglas SSH ${SSH_PORTS[*]}/tcp y ${APP_PORT}/tcp reafirmadas")
else
  APLICADO+=("ufw: habilitado (deny incoming, allow outgoing, SSH ${SSH_PORTS[*]}/tcp, ${APP_PORT}/tcp)")
fi

# --- SSH --------------------------------------------------------------
# Desactivar la contrasena es opt-in: tener authorized_keys no prueba que el
# acceso por clave funcione, y equivocarse deja la maquina sin acceso remoto.
# Activalo (HARDEN_SSH_DISABLE_PASSWORD=1) solo tras entrar con clave.
PASSWORD_AUTH="PasswordAuthentication no"
if [ "${HARDEN_SSH_DISABLE_PASSWORD:-0}" != "1" ]; then
  PASSWORD_AUTH="# PasswordAuthentication no no aplicado: opt-in con HARDEN_SSH_DISABLE_PASSWORD=1"
  warn "se mantiene la autenticacion por contrasena (usa HARDEN_SSH_DISABLE_PASSWORD=1 tras verificar tu acceso por clave)"
  OMITIDO+=("ssh: PasswordAuthentication no (opt-in, HARDEN_SSH_DISABLE_PASSWORD no es 1)")
elif [ -n "${SUDO_USER:-}" ]; then
  SUDO_HOME="$(getent passwd "$SUDO_USER" | awk -F: '{print $6}' || true)"
  if [ -z "$SUDO_HOME" ] || [ ! -s "$SUDO_HOME/.ssh/authorized_keys" ]; then
    PASSWORD_AUTH="# PasswordAuthentication no no aplicado: ${SUDO_USER} no tiene ~/.ssh/authorized_keys"
    warn "se mantiene la autenticacion por contrasena para ${SUDO_USER} (sin ~/.ssh/authorized_keys no vacio)"
    OMITIDO+=("ssh: PasswordAuthentication no (${SUDO_USER} sin authorized_keys)")
  fi
else
  PASSWORD_AUTH="# PasswordAuthentication no no aplicado: SUDO_USER no definido"
  warn "se mantiene la autenticacion por contrasena (SUDO_USER no definido)"
  OMITIDO+=("ssh: PasswordAuthentication no (SUDO_USER no definido)")
fi

# Migra el nombre anterior (99-): ya no tiene efecto frente a otros drop-ins.
if [ -f "$SSH_CONF_LEGACY" ]; then
  rm -f "$SSH_CONF_LEGACY"
  APLICADO+=("ssh: eliminado el drop-in antiguo $SSH_CONF_LEGACY")
fi

write_if_changed "$SSH_CONF" "ssh" <<EOF
# Endurecimiento SSH generado por scripts/harden-server.sh
PermitRootLogin no
MaxAuthTries 3
X11Forwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
$PASSWORD_AUTH
EOF
SSH_CONF_ESCRITO="$WRITE_CHANGED"

if command -v sshd >/dev/null 2>&1; then
  if ! sshd -t; then
    if [ "$SSH_CONF_ESCRITO" = "1" ]; then
      rm -f "$SSH_CONF"
      warn "sshd -t fallo: se elimino $SSH_CONF y se conserva la configuracion anterior"
    fi
    die "sshd -t fallo; no se recarga SSH"
  fi
  log "ssh: 'sshd -t' valido la configuracion"
else
  warn "sshd no encontrado; no se valido la configuracion de SSH"
fi

if [ -f /etc/ssh/sshd_config ] && ! grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config; then
  warn "/etc/ssh/sshd_config no incluye /etc/ssh/sshd_config.d/*.conf; el drop-in no tendria efecto"
fi

if [ "$PASSWORD_AUTH" = "PasswordAuthentication no" ] && grep -qsE '^[[:space:]]*PasswordAuthentication[[:space:]]+yes' /etc/ssh/sshd_config.d/*.conf; then
  warn "otro drop-in de /etc/ssh/sshd_config.d/ fija PasswordAuthentication yes y puede tener prioridad sobre $SSH_CONF"
fi

SSH_UNIT=""
if command -v systemctl >/dev/null 2>&1; then
  if systemctl cat ssh.service >/dev/null 2>&1; then
    SSH_UNIT="ssh.service"
  elif systemctl cat sshd.service >/dev/null 2>&1; then
    SSH_UNIT="sshd.service"
  fi
fi
if [ -n "$SSH_UNIT" ]; then
  if systemctl is-active --quiet "$SSH_UNIT"; then
    systemctl reload "$SSH_UNIT"
    APLICADO+=("ssh: recargado ($SSH_UNIT)")
  else
    warn "$SSH_UNIT no esta activo; la configuracion de SSH se aplicara al arrancarlo"
    OMITIDO+=("ssh: recarga ($SSH_UNIT inactivo)")
  fi
else
  warn "no se encontro ssh.service ni sshd.service; recarga SSH a mano"
  OMITIDO+=("ssh: recarga (unidad no encontrada)")
fi

# --- fail2ban ---------------------------------------------------------
write_if_changed "$FAIL2BAN_CONF" "fail2ban" <<'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
EOF

if command -v systemctl >/dev/null 2>&1 && systemctl cat fail2ban.service >/dev/null 2>&1; then
  systemctl restart fail2ban
  APLICADO+=("fail2ban: jail [sshd] aplicada y servicio reiniciado")
else
  warn "fail2ban.service no esta disponible via systemd; reinicia fail2ban a mano"
  OMITIDO+=("fail2ban: reinicio (sin systemd/fail2ban.service)")
fi

# --- sysctl -----------------------------------------------------------
write_if_changed "$SYSCTL_CONF" "sysctl" <<'EOF'
net.ipv4.conf.all.rp_filter = 1
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
EOF

sysctl --system >/dev/null
APLICADO+=("sysctl: parametros aplicados (sysctl --system)")

# --- Actualizaciones de seguridad automaticas -------------------------
write_if_changed "$AUTO_UPGRADES_CONF" "unattended-upgrades" <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# --- systemd: aislamiento de servicio-login ---------------------------
if command -v systemctl >/dev/null 2>&1 && systemctl cat "$SERVICE_UNIT" >/dev/null 2>&1; then
  # ReadWritePaths exige que la ruta exista: sin ella el servicio no arranca.
  if [ ! -d "$DATA_DIR" ]; then
    mkdir -p "$DATA_DIR"
    if [ -n "${SUDO_USER:-}" ]; then
      chown "$SUDO_USER": "$DATA_DIR"
    fi
    APLICADO+=("systemd: creado $DATA_DIR (ReadWritePaths lo requiere)")
  fi
  chmod 0700 "$DATA_DIR"
  write_if_changed "$SERVICE_DROPIN" "systemd ($SERVICE_UNIT)" <<EOF
[Service]
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA_DIR
EOF
  systemctl daemon-reload
  APLICADO+=("systemd: daemon-reload (el reinicio lo hace scripts/deploy.sh)")
else
  warn "$SERVICE_UNIT no esta instalado; se omite el drop-in (corre npm run vm:setup)"
  OMITIDO+=("systemd: drop-in $SERVICE_UNIT (unidad no instalada)")
fi

# --- Resumen ----------------------------------------------------------
echo
log "resumen del endurecimiento"
if [ "${#APLICADO[@]}" -gt 0 ]; then
  echo "Aplicado:"
  for item in "${APLICADO[@]}"; do
    echo "  - $item"
  done
else
  echo "Aplicado: nada nuevo (el sistema ya estaba endurecido)"
fi
if [ "${#OMITIDO[@]}" -gt 0 ]; then
  echo "Omitido / sin cambios:"
  for item in "${OMITIDO[@]}"; do
    echo "  - $item"
  done
fi
log "endurecimiento completo"
