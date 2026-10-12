#!/usr/bin/env bash
# Publica la telemetria de servicio-login en un repositorio PRIVADO SEPARADO.
#
# Por que un repo aparte (detalle en docs/telemetria.md):
#   1. El repo de la app es publico: publicar ahi expondria la infraestructura
#      (estado del servicio, parches pendientes, intentos de intrusión).
#   2. Darle al servidor escritura sobre el repo que se auto-despliega
#      convertiria la telemetria en una via de inyeccion de codigo.
#
# Contrato:
#   - Siempre ejecuta scripts/collect-metrics.sh y escribe
#     <repo de la app>/data/telemetry/latest.json (visible en el propio host).
#   - Sin TELEMETRY_REPO: registra "telemetria remota no configurada (solo
#     local)" y sale 0.
#   - Guardas antes de publicar: se niega (exit 1) a publicar en el repo de la
#     app y en un repo publico de GitHub (se puede forzar con
#     TELEMETRY_ALLOW_PUBLIC=1). Si no puede verificar la visibilidad del repo,
#     no publica (fail-closed).
#   - Un fallo de red es exit 0: se reintenta en el siguiente ciclo del timer.
#   - Nunca imprime la deploy key ni el contenido del .env de la app.
#
# No usa "set -e" a proposito: los fallos transitorios se registran y se
# reintentan en el siguiente ciclo; solo las negativas de seguridad salen con
# exit distinto de 0.
set -u

# Bajo systemd este script es una copia propiedad de root (instalada por
# install-telemetry.sh) y TELEMETRY_APP_DIR apunta al repo de la app. Root NO
# ejecuta nada del repo: el usuario de la app lo controla (y el auto-update
# trae codigo nuevo ahi), asi que ejecutarlo como root seria una escalada.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${TELEMETRY_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
CONFIG_FILE="/etc/servicio-login/telemetry.env"
KNOWN_HOSTS_FILE="/var/lib/servicio-login/known_hosts"

log() { printf '==> %s\n' "$*"; }
warn() { printf 'AVISO: %s\n' "$*" >&2; }
err() { printf 'ERROR: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- Configuracion: defaults < telemetry.env < variables de entorno --------
ENV_REPO="${TELEMETRY_REPO:-}"
ENV_KEY="${TELEMETRY_SSH_KEY:-}"
ENV_BRANCH="${TELEMETRY_BRANCH:-}"
ENV_DIR="${TELEMETRY_DIR:-}"
ENV_ALLOW_PUBLIC="${TELEMETRY_ALLOW_PUBLIC:-}"
TELEMETRY_REPO=""
TELEMETRY_SSH_KEY=""
TELEMETRY_BRANCH=""
TELEMETRY_DIR=""
TELEMETRY_ALLOW_PUBLIC=""
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$CONFIG_FILE"
  set +a
fi
TELEMETRY_REPO="${ENV_REPO:-${TELEMETRY_REPO:-}}"
TELEMETRY_SSH_KEY="${ENV_KEY:-${TELEMETRY_SSH_KEY:-}}"
TELEMETRY_BRANCH="${ENV_BRANCH:-${TELEMETRY_BRANCH:-main}}"
TELEMETRY_DIR="${ENV_DIR:-${TELEMETRY_DIR:-/var/lib/servicio-login/telemetry}}"
TELEMETRY_ALLOW_PUBLIC="${ENV_ALLOW_PUBLIC:-${TELEMETRY_ALLOW_PUBLIC:-0}}"

# --- 1. Recoleccion (siempre) ----------------------------------------------
JSON="$(bash "$SCRIPT_DIR/collect-metrics.sh" 2>/dev/null || true)"
VALID_JSON=0
if [ -n "$JSON" ] && have node; then
  if printf '%s' "$JSON" | node -e 'let data = "";process.stdin.on("data", (c) => { data += c; });process.stdin.on("end", () => { try { JSON.parse(data); process.exit(0); } catch { process.exit(1); } });' >/dev/null 2>&1; then
    VALID_JSON=1
  fi
fi
if [ "$VALID_JSON" -ne 1 ]; then
  err "collect-metrics no produjo un JSON valido; no se publica (se reintenta en el siguiente ciclo)"
  exit 0
fi

# Copia local en el propio host, aunque no haya repo remoto configurado. Como
# root se escribe en /var/lib (nunca en el data/ del usuario: un symlink
# plantado ahi haria que root sobrescribiera un archivo ajeno).
if [ "$(id -u)" -eq 0 ]; then
  LOCAL_DIR="/var/lib/servicio-login/local"
else
  LOCAL_DIR="$REPO_DIR/data/telemetry"
fi
if mkdir -p "$LOCAL_DIR" 2>/dev/null && printf '%s\n' "$JSON" >"$LOCAL_DIR/latest.json" 2>/dev/null; then
  log "telemetria local: $LOCAL_DIR/latest.json"
else
  warn "no se pudo escribir $LOCAL_DIR/latest.json (se continua)"
fi

if [ -z "$TELEMETRY_REPO" ]; then
  log "telemetria remota no configurada (solo local)"
  exit 0
fi

# --- 2. Guardas obligatorias antes de publicar -----------------------------
normalize_repo() {
  local url="$1"
  local resolved=""
  url="${url%.git}"
  url="${url%/}"
  case "$url" in
    git@github.com:*) url="https://github.com/${url#git@github.com:}" ;;
    ssh://git@github.com/*) url="https://github.com/${url#ssh://git@github.com/}" ;;
  esac
  case "$url" in
    /* | ./* | ../*)
      resolved="$(cd "$url" 2>/dev/null && pwd -P)" || resolved=""
      [ -n "$resolved" ] && url="$resolved"
      ;;
  esac
  printf '%s' "$url"
}

# (a) Nunca publicar en el mismo repo que la aplicacion.
# 'git config --file' solo parsea el archivo: no hace descubrimiento de repo ni
# ejecuta nada de la configuracion del repo (que controla otro usuario).
APP_ORIGIN="$(git config --file "$REPO_DIR/.git/config" --get remote.origin.url 2>/dev/null || true)"
# Se compara sin distinguir mayusculas: GitHub trata Owner/Repo y owner/repo
# como el mismo repositorio.
if [ -n "$APP_ORIGIN" ] && [ "$(normalize_repo "$TELEMETRY_REPO" | tr '[:upper:]' '[:lower:]')" = "$(normalize_repo "$APP_ORIGIN" | tr '[:upper:]' '[:lower:]')" ]; then
  err "TELEMETRY_REPO apunta al MISMO repositorio que la app ($APP_ORIGIN)."
  err "La telemetria va SIEMPRE a un repositorio privado separado, nunca al de la aplicacion."
  exit 1
fi

# (b) Nunca publicar en un repo publico de GitHub sin consentimiento explicito.
if [ "$TELEMETRY_ALLOW_PUBLIC" != "1" ]; then
  case "$TELEMETRY_REPO" in
    *github.com[:/]*)
      GH_REST="${TELEMETRY_REPO#*github.com}"
      GH_REST="${GH_REST#[:/]}"
      GH_REST="${GH_REST%.git}"
      GH_OWNER="${GH_REST%%/*}"
      GH_REPO="${GH_REST#*/}"
      GH_REPO="${GH_REPO%%/*}"
      # Debe haber "owner/repo". (No comparar owner con repo: un repo tipo
      # usuario/usuario es valido y saltaria la comprobacion de visibilidad.)
      if [ -n "$GH_OWNER" ] && [ -n "$GH_REPO" ] && [ "${GH_REST#*/}" != "$GH_REST" ]; then
        if ! have curl; then
          err "no hay curl para verificar si $TELEMETRY_REPO es publico; no se publica (fail-closed)"
          exit 0
        fi
        GH_API="https://api.github.com/repos/${GH_OWNER}/${GH_REPO}"
        GH_CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H 'User-Agent: servicio-login-telemetry' "$GH_API" 2>/dev/null || true)"
        case "$GH_CODE" in
          200)
            err "TELEMETRY_REPO es un repositorio PUBLICO segun $GH_API (HTTP 200)."
            err "Eso expondria la infraestructura: usa un repo privado o define TELEMETRY_ALLOW_PUBLIC=1 a proposito."
            exit 1
            ;;
          404)
            : # privado o inexistente: se continua
            ;;
          *)
            err "no se pudo verificar la visibilidad de $TELEMETRY_REPO (HTTP '${GH_CODE:-sin respuesta}'); no se publica (fail-closed)"
            exit 0
            ;;
        esac
      else
        err "no pude interpretar owner/repo en $TELEMETRY_REPO; no se publica (fail-closed)"
        exit 1
      fi
      ;;
  esac

  # (c) Fail-closed con remotos que no son GitHub ni una ruta local: no hay
  # forma de comprobar su visibilidad desde aqui.
  case "$TELEMETRY_REPO" in
    *github.com[:/]* | /* | ./* | ../* | file://*) ;;
    *)
      err "no puedo verificar la visibilidad de $TELEMETRY_REPO (no es GitHub ni una ruta local)."
      err "Si es un repo privado de otro proveedor, define TELEMETRY_ALLOW_PUBLIC=1 sabiendo que no se comprueba."
      exit 1
      ;;
  esac
fi

# --- 3. Publicacion --------------------------------------------------------
GIT=(git -c core.hooksPath=/dev/null)

if [ -n "$TELEMETRY_SSH_KEY" ]; then
  mkdir -p "$(dirname "$KNOWN_HOSTS_FILE")" 2>/dev/null || true
  export GIT_SSH_COMMAND="ssh -i $TELEMETRY_SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KNOWN_HOSTS_FILE"
fi

LS_REMOTE_OUT=""
if ! LS_REMOTE_OUT="$("${GIT[@]}" ls-remote --heads "$TELEMETRY_REPO" "refs/heads/$TELEMETRY_BRANCH" 2>&1)"; then
  warn "fallo de red al contactar $TELEMETRY_REPO; se reintenta en el siguiente ciclo: $LS_REMOTE_OUT"
  exit 0
fi
REMOTE_BRANCH_EXISTS=0
[ -n "$LS_REMOTE_OUT" ] && REMOTE_BRANCH_EXISTS=1

if [ -e "$TELEMETRY_DIR" ] && [ ! -d "$TELEMETRY_DIR/.git" ]; then
  if [ -n "$(find "$TELEMETRY_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    err "$TELEMETRY_DIR existe y no es un repositorio git; revisa TELEMETRY_DIR"
    exit 1
  fi
fi

if [ -d "$TELEMETRY_DIR/.git" ]; then
  if ! FETCH_OUT="$("${GIT[@]}" -C "$TELEMETRY_DIR" fetch --quiet origin 2>&1)"; then
    warn "fallo de red al actualizar $TELEMETRY_DIR; se reintenta en el siguiente ciclo: $FETCH_OUT"
    exit 0
  fi
  if [ "$REMOTE_BRANCH_EXISTS" -eq 1 ]; then
    if ! "${GIT[@]}" -C "$TELEMETRY_DIR" show-ref --verify --quiet "refs/heads/$TELEMETRY_BRANCH"; then
      if ! CHECKOUT_OUT="$("${GIT[@]}" -C "$TELEMETRY_DIR" checkout --quiet -B "$TELEMETRY_BRANCH" "origin/$TELEMETRY_BRANCH" 2>&1)"; then
        warn "no se pudo crear la rama $TELEMETRY_BRANCH en la copia local: $CHECKOUT_OUT"
        exit 0
      fi
    elif ! CHECKOUT_OUT="$("${GIT[@]}" -C "$TELEMETRY_DIR" checkout --quiet "$TELEMETRY_BRANCH" 2>&1)"; then
      warn "no se pudo cambiar a la rama $TELEMETRY_BRANCH: $CHECKOUT_OUT"
      exit 0
    fi
    # --ff-only: si hubiera divergencia real no se pisa nada; se reintenta.
    if ! MERGE_OUT="$("${GIT[@]}" -C "$TELEMETRY_DIR" merge --ff-only --quiet "origin/$TELEMETRY_BRANCH" 2>&1)"; then
      warn "la copia local de telemetria diverge de origin/$TELEMETRY_BRANCH; se reintenta en el siguiente ciclo: $MERGE_OUT"
      exit 0
    fi
  fi
else
  if [ "$REMOTE_BRANCH_EXISTS" -eq 1 ]; then
    if ! CLONE_OUT="$("${GIT[@]}" clone --quiet --branch "$TELEMETRY_BRANCH" --single-branch "$TELEMETRY_REPO" "$TELEMETRY_DIR" 2>&1)"; then
      warn "no se pudo clonar $TELEMETRY_REPO; se reintenta en el siguiente ciclo: $CLONE_OUT"
      exit 0
    fi
  else
    if ! CLONE_OUT="$("${GIT[@]}" clone --quiet "$TELEMETRY_REPO" "$TELEMETRY_DIR" 2>&1)"; then
      warn "no se pudo clonar $TELEMETRY_REPO; se reintenta en el siguiente ciclo: $CLONE_OUT"
      exit 0
    fi
    # Repo remoto vacio: deja lista la rama pedida (aun sin commits).
    "${GIT[@]}" -C "$TELEMETRY_DIR" checkout --quiet -B "$TELEMETRY_BRANCH" 2>/dev/null || true
  fi
fi

T_DATA="$TELEMETRY_DIR/data/telemetry"
if ! mkdir -p "$T_DATA/history" 2>/dev/null; then
  err "no se pudo preparar $T_DATA"
  exit 1
fi
if ! printf '%s\n' "$JSON" >"$T_DATA/latest.json"; then
  err "no se pudo escribir $T_DATA/latest.json"
  exit 1
fi
TODAY="$(date -u +%Y-%m-%d)"
if ! printf '%s\n' "$JSON" >>"$T_DATA/history/$TODAY.jsonl"; then
  err "no se pudo anexar $T_DATA/history/$TODAY.jsonl"
  exit 1
fi

# STATUS.md legible: valores actuales + resumen de las ultimas 24 h.
TMP_STATUS="$(mktemp -d "${TMPDIR:-/tmp}/telemetry-status.XXXXXX" 2>/dev/null)" || TMP_STATUS=""
if [ -n "$TMP_STATUS" ]; then
  cat >"$TMP_STATUS/status.js" <<'NODE'
"use strict";
const fs = require("fs");
const path = require("path");

const telemetryDir = path.join(process.argv[2], "data", "telemetry");

function readLatest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(telemetryDir, "latest.json"), "utf8"));
  } catch (err) {
    return null;
  }
}

function readSamples() {
  const samples = [];
  let names;
  try {
    names = fs.readdirSync(path.join(telemetryDir, "history"));
  } catch (err) {
    return samples;
  }
  for (const name of names) {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$/.test(name)) continue;
    let raw;
    try {
      raw = fs.readFileSync(path.join(telemetryDir, "history", name), "utf8");
    } catch (err) {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        samples.push(JSON.parse(line));
      } catch (err) {
        // linea corrupta: se ignora
      }
    }
  }
  return samples;
}

const show = (value) => (value === null || value === undefined || value === "" ? "-" : String(value));

const latest = readLatest();
const samples = readSamples();

const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const recent = samples.filter((sample) => {
  const t = Date.parse(sample && sample.ts);
  return Number.isFinite(t) && t >= cutoff;
});

const numeric = (values) => values.filter((v) => typeof v === "number" && Number.isFinite(v));
const minOf = (values) => (values.length ? Math.min.apply(null, values) : null);
const maxOf = (values) => (values.length ? Math.max.apply(null, values) : null);
const sumOf = (values) => (values.length ? values.reduce((a, b) => a + b, 0) : null);

const load1 = numeric(recent.map((s) => s.load1));
const appErrors = numeric(recent.map((s) => s.app_log_counts_1h && s.app_log_counts_1h.error));
const sshFailed = numeric(recent.map((s) => s.ssh_failed_1h));

const FIELDS = [
  "ts", "uptime_s", "load1", "load5", "load15", "mem_used_pct", "disk_used_pct",
  "service_active", "service_restarts", "health_http_code", "health_ms",
  "db_size_bytes", "backups_count", "backup_newest_age_s", "deployed_sha",
  "last_update", "ufw_active", "fail2ban_banned", "ssh_failed_1h",
  "app_log_counts_1h", "security_updates_pending", "reboot_required",
];

function formatField(key) {
  if (!latest) return "-";
  const value = latest[key];
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "object") {
    if (key === "app_log_counts_1h") {
      return show(value.info) + " info / " + show(value.warn) + " warn / " + show(value.error) + " error";
    }
    if (key === "last_update") {
      return "sha=" + show(value.sha) + " at=" + show(value.at) + " result=" + show(value.result);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

const lines = [];
lines.push("# Telemetria de servicio-login");
lines.push("");
lines.push("Actualizado: " + show(latest && latest.ts) + " (UTC)");
lines.push("");
lines.push("## Estado actual");
lines.push("");
lines.push("| Metrica | Valor |");
lines.push("| --- | --- |");
for (const field of FIELDS) lines.push("| " + field + " | " + formatField(field) + " |");
lines.push("");
lines.push("## Ultimas 24 horas");
lines.push("");
lines.push("| Resumen | Valor |");
lines.push("| --- | --- |");
lines.push("| Muestras | " + recent.length + " |");
lines.push("| load1 min / max | " + show(minOf(load1)) + " / " + show(maxOf(load1)) + " |");
lines.push("| Errores de app (max. por muestra) | " + show(maxOf(appErrors)) + " |");
lines.push("| Errores de app (suma de muestras) | " + show(sumOf(appErrors)) + " |");
lines.push("| Intentos SSH fallidos (max. por muestra) | " + show(maxOf(sshFailed)) + " |");
lines.push("| Intentos SSH fallidos (suma de muestras) | " + show(sumOf(sshFailed)) + " |");
lines.push("");

fs.writeFileSync(path.join(telemetryDir, "STATUS.md"), lines.join("\n") + "\n");
NODE
  if ! node "$TMP_STATUS/status.js" "$TELEMETRY_DIR" 2>/dev/null; then
    warn "no se pudo regenerar STATUS.md (se publica el resto)"
  fi
  rm -rf "$TMP_STATUS"
else
  warn "mktemp fallo; se publica sin regenerar STATUS.md"
fi

# Rotacion: history con mas de 30 dias afuera.
CUTOFF_EPOCH="$(date -u -d '30 days ago' +%s 2>/dev/null || true)"
if [ -n "$CUTOFF_EPOCH" ]; then
  for HISTORY_FILE in "$T_DATA/history"/*.jsonl; do
    [ -e "$HISTORY_FILE" ] || continue
    HISTORY_DATE="$(basename "$HISTORY_FILE" .jsonl)"
    case "$HISTORY_DATE" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
      *) continue ;;
    esac
    FILE_EPOCH="$(date -u -d "$HISTORY_DATE" +%s 2>/dev/null || true)"
    if [ -n "$FILE_EPOCH" ] && [ "$FILE_EPOCH" -lt "$CUTOFF_EPOCH" ]; then
      rm -f "$HISTORY_FILE"
      log "history: eliminado $HISTORY_DATE (>30 dias)"
    fi
  done
fi

if [ -z "$("${GIT[@]}" -C "$TELEMETRY_DIR" status --porcelain 2>/dev/null)" ]; then
  log "telemetria sin cambios; nada que publicar"
  exit 0
fi

if ! "${GIT[@]}" -C "$TELEMETRY_DIR" add -A 2>/dev/null; then
  err "no se pudo preparar el commit en $TELEMETRY_DIR"
  exit 1
fi

COMMIT_MSG="telemetria $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! COMMIT_OUT="$("${GIT[@]}" -C "$TELEMETRY_DIR" \
    -c user.name="servicio-login-telemetry" \
    -c user.email="telemetry@localhost" \
    commit --quiet --author "servicio-login-telemetry <telemetry@localhost>" -m "$COMMIT_MSG" 2>&1)"; then
  warn "no se pudo crear el commit de telemetria: $COMMIT_OUT"
  exit 0
fi

if ! PUSH_OUT="$("${GIT[@]}" -C "$TELEMETRY_DIR" push --quiet origin "HEAD:refs/heads/$TELEMETRY_BRANCH" 2>&1)"; then
  warn "fallo al publicar la telemetria (push); se reintenta en el siguiente ciclo: $PUSH_OUT"
  exit 0
fi

log "telemetria publicada en $TELEMETRY_REPO (rama $TELEMETRY_BRANCH)"
