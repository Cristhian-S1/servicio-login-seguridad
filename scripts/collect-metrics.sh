#!/usr/bin/env bash
# Recolecta metricas agregadas del servidor y las imprime como UN objeto JSON.
#
# Reglas de este script (telemetria segura):
#   - NUNCA aborta: cada campo es best-effort; si no se puede obtener queda en
#     null y la recoleccion continua.
#   - NUNCA expone datos sensibles: sin IPs, sin nombres de usuario, sin lineas
#     crudas de log, sin contenido de .env ni de la base. Solo contadores y
#     agregados.
#   - stdout es EXACTAMENTE un objeto JSON (una linea). El consumidor es
#     scripts/publish-telemetry.sh, que parsea stdout; usa stderr con cuidado.
#
# A proposito NO usa "set -e": un fallo puntual no debe tumbar el JSON.
#
# Uso: bash scripts/collect-metrics.sh

# Directorio de la app. Bajo systemd (como root) el script vive en una copia
# propiedad de root y TELEMETRY_APP_DIR apunta al repo: root NUNCA ejecuta
# codigo del repo (lo escribe el usuario de la app) y solo LEE datos de el.
REPO_DIR="${TELEMETRY_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

have() { command -v "$1" >/dev/null 2>&1; }

# --- Rutas de datos (mismas reglas que la app y scripts/backup-db.ts) -----
DB_FILE="${DB_PATH:-./data/login.db}"
case "$DB_FILE" in
  :memory:*) DB_FILE="" ;;
  /*) ;;
  *) DB_FILE="$REPO_DIR/${DB_FILE#./}" ;;
esac
if [ -n "$DB_FILE" ]; then
  DATA_DIR="$(dirname "$DB_FILE")"
else
  DATA_DIR="$REPO_DIR/data"
fi
BACKUP_PATH="${BACKUP_DIR:-$DATA_DIR/backups}"
case "$BACKUP_PATH" in
  /*) ;;
  *) BACKUP_PATH="$REPO_DIR/${BACKUP_PATH#./}" ;;
esac

# --- Sistema --------------------------------------------------------------
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"

uptime_s=""
if [ -r /proc/uptime ]; then
  uptime_s="$(awk '{ printf "%d", $1 }' /proc/uptime 2>/dev/null || true)"
fi

load1=""
load5=""
load15=""
if [ -r /proc/loadavg ]; then
  read -r load1 load5 load15 _ </proc/loadavg || true
fi

mem_used_pct=""
if [ -r /proc/meminfo ]; then
  mem_used_pct="$(awk '/^MemTotal:/ { total = $2 } /^MemAvailable:/ { avail = $2 } END { if (total > 0 && avail != "") printf "%.1f", (total - avail) * 100 / total }' /proc/meminfo 2>/dev/null || true)"
fi

disk_used_pct=""
DISK_TARGET="$DATA_DIR"
[ -d "$DISK_TARGET" ] || DISK_TARGET="$REPO_DIR"
disk_used_pct="$(df -P "$DISK_TARGET" 2>/dev/null | awk 'NR == 2 { sub(/%/, "", $5); print $5 }' || true)"

# --- Servicio systemd -----------------------------------------------------
# Si la unidad no esta instalada (LoadState=not-found) se reporta null en vez
# de un falso "inactive"/0, para no confundir telemetria de otra maquina.
SVC_LOAD_STATE=""
if have systemctl; then
  SVC_LOAD_STATE="$(systemctl show servicio-login -p LoadState --value 2>/dev/null || true)"
fi

service_active=""
if [ -n "$SVC_LOAD_STATE" ] && [ "$SVC_LOAD_STATE" != "not-found" ]; then
  SVC_STATE="$(systemctl is-active servicio-login 2>/dev/null || true)"
  case "$SVC_STATE" in
    active) service_active="true" ;;
    inactive | failed | activating | deactivating) service_active="false" ;;
  esac
fi

service_restarts=""
if [ -n "$SVC_LOAD_STATE" ] && [ "$SVC_LOAD_STATE" != "not-found" ]; then
  service_restarts="$(systemctl show servicio-login -p NRestarts --value 2>/dev/null || true)"
fi
case "$service_restarts" in
  '' | *[!0-9]*) service_restarts="" ;;
esac

health_http_code=""
health_ms=""
if have curl; then
  HEALTH_RAW="$(curl -s -o /dev/null -m 3 -w '%{http_code} %{time_total}' "http://127.0.0.1:${PORT:-3000}/health" 2>/dev/null || true)"
  HEALTH_CODE="${HEALTH_RAW%% *}"
  HEALTH_TIME="${HEALTH_RAW##* }"
  case "$HEALTH_CODE" in
    [1-9][0-9][0-9]) health_http_code="$HEALTH_CODE" ;;
  esac
  if [ -n "$health_http_code" ]; then
    health_ms="$(awk -v t="$HEALTH_TIME" 'BEGIN { if (t + 0 > 0) printf "%d", t * 1000 }' 2>/dev/null || true)"
  fi
fi

# --- Base de datos y backups ----------------------------------------------
db_size_bytes=""
if [ -n "$DB_FILE" ] && [ -f "$DB_FILE" ]; then
  db_size_bytes="$(wc -c <"$DB_FILE" 2>/dev/null | tr -d '[:space:]' || true)"
fi
case "$db_size_bytes" in
  '' | *[!0-9]*) db_size_bytes="" ;;
esac

backups_count=""
backup_newest_age_s=""
if [ -d "$BACKUP_PATH" ]; then
  backups_count="$(find "$BACKUP_PATH" -maxdepth 1 -type f -name 'login-*.db' 2>/dev/null | awk 'END { printf "%d", NR }')"
  NEWEST_EPOCH="$(find "$BACKUP_PATH" -maxdepth 1 -type f -name 'login-*.db' -printf '%T@\n' 2>/dev/null | sort -nr | head -n 1 || true)"
  case "$NEWEST_EPOCH" in
    '' | *[!0-9.]*) : ;;
    *)
      NOW_EPOCH="$(date -u +%s 2>/dev/null || true)"
      backup_newest_age_s="$(awk -v newest="$NEWEST_EPOCH" -v now="$NOW_EPOCH" 'BEGIN { if (now > newest) printf "%d", now - newest }' 2>/dev/null || true)"
      ;;
  esac
fi

# --- Despliegue -----------------------------------------------------------
# El SHA se lee de .git/HEAD a mano, sin invocar git: este script corre como
# root sobre un repo cuyo .git/config controla otro usuario, y git consulta esa
# configuracion (git tambien se niega por "dubious ownership").
deployed_sha=""
if [ -r "$REPO_DIR/.git/HEAD" ]; then
  HEAD_CONTENT="$(head -n 1 "$REPO_DIR/.git/HEAD" 2>/dev/null || true)"
  case "$HEAD_CONTENT" in
    "ref: refs/heads/"*)
      HEAD_REF="${HEAD_CONTENT#ref: }"
      case "$HEAD_REF" in
        *..* | *[!A-Za-z0-9._/-]*) HEAD_REF="" ;;
      esac
      FULL_SHA=""
      if [ -n "$HEAD_REF" ] && [ -r "$REPO_DIR/.git/$HEAD_REF" ]; then
        FULL_SHA="$(head -n 1 "$REPO_DIR/.git/$HEAD_REF" 2>/dev/null || true)"
      elif [ -n "$HEAD_REF" ] && [ -r "$REPO_DIR/.git/packed-refs" ]; then
        FULL_SHA="$(awk -v ref="$HEAD_REF" '$2 == ref { print $1; exit }' "$REPO_DIR/.git/packed-refs" 2>/dev/null || true)"
      fi
      ;;
    *) FULL_SHA="$HEAD_CONTENT" ;;
  esac
  case "$FULL_SHA" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) deployed_sha="${FULL_SHA:0:7}" ;;
  esac
fi

LAST_UPDATE_FILE="$DATA_DIR/auto-update/status.json"
[ -f "$LAST_UPDATE_FILE" ] || LAST_UPDATE_FILE=""

# --- Endurecimiento -------------------------------------------------------
ufw_active=""
if have ufw; then
  UFW_LINE="$(ufw status 2>/dev/null | head -n 1 || true)"
  case "$UFW_LINE" in
    "Status: active") ufw_active="true" ;;
    "Status: inactive") ufw_active="false" ;;
  esac
fi

fail2ban_banned=""
if have fail2ban-client; then
  JAILS="$(fail2ban-client status 2>/dev/null | awk -F: '/Jail list/ { gsub(/[[:space:]]/, "", $2); gsub(/,/, " ", $2); print $2 }' || true)"
  if [ -n "$JAILS" ]; then
    read -r -a JAIL_LIST <<<"$JAILS"
    F2B_TOTAL=0
    F2B_OK=1
    for jail in "${JAIL_LIST[@]}"; do
      JAIL_BANNED="$(fail2ban-client status "$jail" 2>/dev/null | awk -F: '/Currently banned/ { gsub(/[^0-9]/, "", $2); print $2 }' || true)"
      case "$JAIL_BANNED" in
        '' | *[!0-9]*) F2B_OK=0 ;;
        *) F2B_TOTAL=$((F2B_TOTAL + JAIL_BANNED)) ;;
      esac
    done
    if [ "$F2B_OK" -eq 1 ]; then
      fail2ban_banned="$F2B_TOTAL"
    fi
  fi
fi

# --- Logs agregados (solo contadores; nunca mensajes ni usuarios) ---------
ssh_failed_1h=""
app_log_counts=""
if have journalctl && journalctl -q -n 0 >/dev/null 2>&1; then
  ssh_failed_1h="$(journalctl -q -u ssh -u sshd -o cat --since '1 hour ago' 2>/dev/null | awk '/Failed password/ { n++ } END { printf "%d", n + 0 }' || true)"
  if have node; then
    app_log_counts="$(journalctl -q -u servicio-login -o cat --since '1 hour ago' 2>/dev/null | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const counts = { info: 0, warn: 0, error: 0 };
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let level;
    try { level = String(JSON.parse(line).level || "").toLowerCase(); } catch { continue; }
    if (level === "info") counts.info += 1;
    else if (level === "warn" || level === "warning") counts.warn += 1;
    else if (level === "error") counts.error += 1;
  }
  process.stdout.write(JSON.stringify(counts));
});
' 2>/dev/null || true)"
  fi
fi

# --- Actualizaciones del sistema ------------------------------------------
security_updates_pending=""
if have apt-get; then
  security_updates_pending="$(apt list --upgradable 2>/dev/null | grep -ci 'security' || true)"
fi
case "$security_updates_pending" in
  '' | *[!0-9]*) security_updates_pending="" ;;
esac

reboot_required="false"
if [ -e /var/run/reboot-required ]; then
  reboot_required="true"
fi

# --- JSON (node escapa correctamente; no se usa jq) -----------------------
if ! have node; then
  # Sin node no se puede construir el objeto completo: se emite un JSON
  # minimo pero valido para que el consumidor nunca reciba basura.
  MIN_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  if [ -n "$MIN_TS" ]; then
    printf '{"ts":"%s"}\n' "$MIN_TS"
  else
    printf '{"ts":null}\n'
  fi
  exit 0
fi

json="$(
  C_TS="$ts" \
  C_UPTIME_S="$uptime_s" \
  C_LOAD1="$load1" \
  C_LOAD5="$load5" \
  C_LOAD15="$load15" \
  C_MEM_USED_PCT="$mem_used_pct" \
  C_DISK_USED_PCT="$disk_used_pct" \
  C_SERVICE_ACTIVE="$service_active" \
  C_SERVICE_RESTARTS="$service_restarts" \
  C_HEALTH_HTTP_CODE="$health_http_code" \
  C_HEALTH_MS="$health_ms" \
  C_DB_SIZE_BYTES="$db_size_bytes" \
  C_BACKUPS_COUNT="$backups_count" \
  C_BACKUP_NEWEST_AGE_S="$backup_newest_age_s" \
  C_DEPLOYED_SHA="$deployed_sha" \
  C_LAST_UPDATE_FILE="$LAST_UPDATE_FILE" \
  C_UFW_ACTIVE="$ufw_active" \
  C_FAIL2BAN_BANNED="$fail2ban_banned" \
  C_SSH_FAILED_1H="$ssh_failed_1h" \
  C_APP_LOG_COUNTS="$app_log_counts" \
  C_SECURITY_UPDATES_PENDING="$security_updates_pending" \
  C_REBOOT_REQUIRED="$reboot_required" \
  node -e '
const asNumber = (value) => {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const asBool = (value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
};
const asString = (value) => (value === undefined || value === "" ? null : value);

const readLastUpdate = (file) => {
  if (!file) return null;
  try {
    const fs = require("fs");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const pick = (key) => (raw && raw[key] !== undefined ? raw[key] : null);
    return { sha: pick("sha"), at: pick("at"), result: pick("result") };
  } catch {
    return null;
  }
};

const readAppLogCounts = (value) => {
  if (value === undefined || value === "") return null;
  try {
    const counts = JSON.parse(value);
    return {
      info: asNumber(String(counts.info)),
      warn: asNumber(String(counts.warn)),
      error: asNumber(String(counts.error)),
    };
  } catch {
    return null;
  }
};

const out = {
  ts: asString(process.env.C_TS),
  uptime_s: asNumber(process.env.C_UPTIME_S),
  load1: asNumber(process.env.C_LOAD1),
  load5: asNumber(process.env.C_LOAD5),
  load15: asNumber(process.env.C_LOAD15),
  mem_used_pct: asNumber(process.env.C_MEM_USED_PCT),
  disk_used_pct: asNumber(process.env.C_DISK_USED_PCT),
  service_active: asBool(process.env.C_SERVICE_ACTIVE),
  service_restarts: asNumber(process.env.C_SERVICE_RESTARTS),
  health_http_code: asNumber(process.env.C_HEALTH_HTTP_CODE),
  health_ms: asNumber(process.env.C_HEALTH_MS),
  db_size_bytes: asNumber(process.env.C_DB_SIZE_BYTES),
  backups_count: asNumber(process.env.C_BACKUPS_COUNT),
  backup_newest_age_s: asNumber(process.env.C_BACKUP_NEWEST_AGE_S),
  deployed_sha: asString(process.env.C_DEPLOYED_SHA),
  last_update: readLastUpdate(process.env.C_LAST_UPDATE_FILE),
  ufw_active: asBool(process.env.C_UFW_ACTIVE),
  fail2ban_banned: asNumber(process.env.C_FAIL2BAN_BANNED),
  ssh_failed_1h: asNumber(process.env.C_SSH_FAILED_1H),
  app_log_counts_1h: readAppLogCounts(process.env.C_APP_LOG_COUNTS),
  security_updates_pending: asNumber(process.env.C_SECURITY_UPDATES_PENDING),
  reboot_required: asBool(process.env.C_REBOOT_REQUIRED),
};
process.stdout.write(JSON.stringify(out));
'
)" || json=""

if [ -z "$json" ]; then
  json='{"ts":null}'
fi
printf '%s\n' "$json"
