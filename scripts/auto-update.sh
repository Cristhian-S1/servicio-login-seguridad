#!/usr/bin/env bash
# Auto-actualizacion del servidor: trae los cambios de main y despliega.
#
# Modelo POLLING: la VM (Proxmox, sin entrada desde internet) no puede recibir
# un webhook de GitHub, asi que un timer systemd ejecuta este script cada 5
# minutos; el script consulta origin/<rama> y, si hay un commit nuevo con la
# compuerta de CI en verde, corre `npm run deploy` (backup + migraciones).
#
# Corre como el usuario dueno del repo (NUNCA root) y es idempotente: sin
# cambios no hace nada.
#   Instalacion: sudo bash scripts/install-auto-update.sh
#   Docs: docs/auto-actualizacion.md
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

if [ "$(id -u)" -eq 0 ]; then
  log "ERROR: no corras este script como root; debe correr como el usuario dueno del repo"
  exit 1
fi

# --- Configuracion -----------------------------------------------------------
# /etc/servicio-login/auto-update.env (opcional, no versionado) puede definir
# cualquiera de estas variables; las que no defina usan el default de abajo.
if [ -f /etc/servicio-login/auto-update.env ]; then
  # shellcheck source=/dev/null
  . /etc/servicio-login/auto-update.env
fi

AUTO_UPDATE_BRANCH="${AUTO_UPDATE_BRANCH:-main}"
AUTO_UPDATE_REQUIRE_CI="${AUTO_UPDATE_REQUIRE_CI:-1}"
AUTO_UPDATE_DRY_RUN="${AUTO_UPDATE_DRY_RUN:-0}"
AUTO_UPDATE_HARDENING="${AUTO_UPDATE_HARDENING:-0}"
AUTO_UPDATE_ALLOWED_SIGNERS="${AUTO_UPDATE_ALLOWED_SIGNERS:-}"
AUTO_UPDATE_STATE_DIR="${AUTO_UPDATE_STATE_DIR:-$REPO_DIR/data/auto-update}"
AUTO_UPDATE_HEALTH_URL="${AUTO_UPDATE_HEALTH_URL:-http://127.0.0.1:${PORT:-3000}/health}"

STATE_DIR="$AUTO_UPDATE_STATE_DIR"
LOCK_FILE="$STATE_DIR/lock"
STATUS_FILE="$STATE_DIR/status.json"
LAST_FAILED_FILE="$STATE_DIR/last-failed-sha"

write_status() {
  printf '{"sha":"%s","at":"%s","result":"%s"}\n' \
    "$1" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$2" > "$STATUS_FILE.tmp"
  mv "$STATUS_FILE.tmp" "$STATUS_FILE"
}

mark_failed_sha() {
  printf '%s\n' "$1" > "$LAST_FAILED_FILE.tmp"
  mv "$LAST_FAILED_FILE.tmp" "$LAST_FAILED_FILE"
}

# --- a) Exclusion mutua: una sola auto-actualizacion a la vez ----------------
if ! mkdir -p "$STATE_DIR"; then
  log "ERROR: no puedo crear el directorio de estado $STATE_DIR"
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "ya hay otra auto-actualizacion en curso; se omite esta"
  exit 0
fi

# --- b) Traer la rama remota (con timeout) -----------------------------------
# Sin red: se registra y se reintenta en el proximo tick.
export GIT_TERMINAL_PROMPT=0
if ! fetch_output="$(timeout 60 git fetch origin "$AUTO_UPDATE_BRANCH" 2>&1)"; then
  fetch_detail="$(printf '%s' "$fetch_output" | tr '\n' ' ')"
  log "sin red, se reintenta en el proximo tick (detalle: $fetch_detail)"
  exit 0
fi

if ! remote_sha="$(git rev-parse "origin/$AUTO_UPDATE_BRANCH")"; then
  log "ERROR: no existe origin/$AUTO_UPDATE_BRANCH tras el fetch"
  exit 1
fi
local_sha="$(git rev-parse HEAD)"

# --- c) Sin cambios -----------------------------------------------------------
if [ "$local_sha" = "$remote_sha" ]; then
  log "sin cambios"
  exit 0
fi

# --- d) Condiciones para desplegar: arbol limpio y fast-forward ---------------
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "ERROR: hay cambios locales en archivos rastreados; no se despliega"
  exit 1
fi

if ! git merge-base --is-ancestor "$local_sha" "$remote_sha"; then
  log "ERROR: origin/$AUTO_UPDATE_BRANCH no es descendiente de HEAD (no es fast-forward); no se despliega"
  exit 1
fi

# --- e) Commit que ya fallo antes: no se reintenta (silencio a proposito) -----
if [ -f "$LAST_FAILED_FILE" ] && [ "$(cat "$LAST_FAILED_FILE")" = "$remote_sha" ]; then
  exit 0
fi

# --- f) Compuerta de CI -------------------------------------------------------
# Exige que exista el check run "verify" y que TODOS los check runs del commit
# esten completed y en success. Se consulta sin token (repo publico) y se
# parsea con node. Si la API falla, no se despliega (fail-closed).
if [ "$AUTO_UPDATE_REQUIRE_CI" = "1" ]; then
  if ! remote_url="$(git remote get-url origin)"; then
    log "ERROR: no hay remoto 'origin'; no se despliega (fail-closed)"
    exit 0
  fi

  case "$remote_url" in
    git@github.com:*)       owner_repo="${remote_url#git@github.com:}" ;;
    ssh://git@github.com/*) owner_repo="${remote_url#ssh://git@github.com/}" ;;
    https://github.com/*)   owner_repo="${remote_url#https://github.com/}" ;;
    http://github.com/*)    owner_repo="${remote_url#http://github.com/}" ;;
    *)                      owner_repo="" ;;
  esac
  owner_repo="${owner_repo%.git}"

  if [ -z "$owner_repo" ] || [ "${owner_repo#*/}" = "$owner_repo" ]; then
    log "ERROR: origin no apunta a GitHub ('$remote_url'); no se despliega (fail-closed)"
    exit 0
  fi
  owner="${owner_repo%%/*}"
  repo_name="${owner_repo#*/}"

  checks_url="https://api.github.com/repos/$owner/$repo_name/commits/$remote_sha/check-runs?per_page=100"
  if ! checks_json="$(curl -fsS --max-time 15 \
      -H 'Accept: application/vnd.github+json' \
      -H 'User-Agent: servicio-login-auto-update' \
      "$checks_url")"; then
    log "la API de GitHub no respondio; no se despliega (fail-closed); se reintenta en el proximo tick"
    exit 0
  fi

  verdict="$(printf '%s' "$checks_json" | node -e '
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(raw); } catch (e) { console.log("error"); return; }
  const runs = Array.isArray(data.check_runs) ? data.check_runs : [];
  const total = typeof data.total_count === "number" ? data.total_count : runs.length;
  if (total < 1 || runs.length < 1) { console.log("pending"); return; }
  if (total > runs.length) { console.log("error"); return; }
  if (runs.some((r) => r.status !== "completed")) { console.log("pending"); return; }
  const passing = ["success", "neutral", "skipped"];
  if (runs.some((r) => !passing.includes(r.conclusion))) { console.log("failed"); return; }
  if (!runs.some((r) => r.name === "verify" && r.conclusion === "success")) { console.log("missing-verify"); return; }
  console.log("ok");
});
')"

  case "$verdict" in
    ok)
      log "compuerta de CI en verde ($owner/$repo_name @ $remote_sha)"
      ;;
    pending)
      log "esperando CI: hay checks sin completar; se reintenta en el proximo tick"
      exit 0
      ;;
    failed|missing-verify)
      log "ERROR: la compuerta de CI no paso ($verdict); no se despliega $remote_sha"
      mark_failed_sha "$remote_sha"
      exit 0
      ;;
    *)
      log "ERROR: respuesta inesperada de la API de checks ('$verdict'); no se despliega (fail-closed)"
      exit 0
      ;;
  esac
fi

# --- g) Firma opcional del commit ----------------------------------------------
# Solo si AUTO_UPDATE_ALLOWED_SIGNERS esta definido (allowed signers de SSH).
if [ -n "$AUTO_UPDATE_ALLOWED_SIGNERS" ]; then
  if [ ! -f "$AUTO_UPDATE_ALLOWED_SIGNERS" ]; then
    log "ERROR: AUTO_UPDATE_ALLOWED_SIGNERS no existe ($AUTO_UPDATE_ALLOWED_SIGNERS); no se despliega"
    exit 1
  fi
  if git -c "gpg.ssh.allowedSignersFile=$AUTO_UPDATE_ALLOWED_SIGNERS" verify-commit "$remote_sha" >/dev/null 2>&1; then
    log "firma valida del commit $remote_sha"
  else
    log "ERROR: el commit $remote_sha no tiene una firma valida en $AUTO_UPDATE_ALLOWED_SIGNERS; no se despliega"
    mark_failed_sha "$remote_sha"
    exit 1
  fi
fi

# --- h) Simulacion (no toca el repo) -------------------------------------------
if [ "$AUTO_UPDATE_DRY_RUN" = "1" ]; then
  log "DRY-RUN: desplegaria $remote_sha"
  exit 0
fi

# --- i) Actualizar y desplegar --------------------------------------------------
# deploy.sh ya respalda la base, migra y reinicia el servicio. El
# endurecimiento del sistema (harden-server.sh) queda manual: se omite con
# SKIP_HARDENING=1 salvo que AUTO_UPDATE_HARDENING=1.
if [ "$AUTO_UPDATE_HARDENING" != "1" ]; then
  export SKIP_HARDENING=1
fi

# Se avanza al SHA exacto que paso la compuerta (no a "lo ultimo de la rama":
# main pudo avanzar mientras tanto) y se le dice a deploy.sh que no haga otro
# pull, que podria traer un commit posterior sin verificar.
export SKIP_GIT_PULL=1
log "desplegando $remote_sha ($local_sha -> $remote_sha)"
if ! git merge --ff-only "$remote_sha"; then
  log "ERROR: git merge --ff-only $remote_sha fallo; no se despliega"
  exit 1
fi

if ! npm run deploy; then
  log "ERROR: npm run deploy fallo; se marca $remote_sha como fallido (revisa el journal)"
  mark_failed_sha "$remote_sha"
  write_status "$remote_sha" "failed"
  exit 1
fi

# --- j) Health check (sin rollback automatico) ----------------------------------
# Si falla, la base pudo migrar: los backups previos estan en data/backups.
health_ok="0"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 "$AUTO_UPDATE_HEALTH_URL" >/dev/null 2>&1; then
    health_ok="1"
    break
  fi
  sleep 2
done

if [ "$health_ok" = "1" ]; then
  write_status "$remote_sha" "ok"
  log "despliegue OK ($remote_sha); health responde en $AUTO_UPDATE_HEALTH_URL"
  exit 0
fi

log "ERROR: health no respondio tras 10 intentos ($AUTO_UPDATE_HEALTH_URL); sin rollback automatico (ver docs/auto-actualizacion.md)"
mark_failed_sha "$remote_sha"
write_status "$remote_sha" "failed"
exit 1
