#!/usr/bin/env bash
# Demo para la defensa: recorre el servicio en vivo y verifica cada control.
# Requisitos: stack levantado (docker compose up), migraciones y seed hechos,
# python3 y curl instalados. Uso: BASE=http://localhost:3000 ./scripts/demo-defensa.sh
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
PASS="${SEED_PASSWORD:-}"
[ -n "$PASS" ] || { echo "SEED_PASSWORD requerido (el mismo del seed)"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

step() { echo; echo "=== $1 ==="; }
ok() { echo "  ok: $1"; }

api() { # api METHOD PATH [TOKEN] [DATA] -> deja status en $TMP/status y body en $TMP/body
  local method="$1" path="$2" token="${3:-}" data="${4:-}"
  local args=(-s -o "$TMP/body" -w "%{http_code}")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" -d "$data")
  curl "${args[@]}" -X "$method" "$BASE$path" > "$TMP/status"
}

expect() { # expect STATUS "descripcion"
  local want="$1" desc="$2" got
  got="$(cat "$TMP/status")"
  if [ "$got" != "$want" ]; then
    echo "  FALLO: $desc: espero $want, llego $got"; cat "$TMP/body"; echo; exit 1
  fi
  ok "$desc ($want)"
}

jget() { python3 -c "import json,sys; print(json.load(open('$TMP/body'))$1)"; }

totp() { # totp SECRET -> codigo TOTP actual (RFC 6238, SHA1, 30s; stdlib python)
  python3 - "$1" <<'EOF'
import base64, hashlib, hmac, struct, sys, time
secret = sys.argv[1]
key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
msg = struct.pack(">Q", int(time.time()) // 30)
h = hmac.new(key, msg, hashlib.sha1).digest()
o = h[-1] & 0x0F
print(str(struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF)[-6:].zfill(6))
EOF
}

jwt_claim() { # jwt_claim TOKEN .mfa -> decodifica el payload sin verificar (solo demo)
  python3 - "$1" <<'EOF'
import base64, json, sys
payload = sys.argv[1].split(".")[1]
print(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["mfa"])
EOF
}

step "0. prerequisitos: stack con seed"
api POST /auth/login "" "{\"email\":\"user@example.com\",\"password\":\"$PASS\"}"
expect 200 "seed presente (login user@example.com)"
USER_TOKEN="$(jget "['accessToken']")"

step "1. registro + login + perfil"
api POST /auth/register "" '{"email":"demo@example.com","password":"Dem0!Passw0rd-larga"}'
[ "$(cat "$TMP/status")" = "201" ] || [ "$(cat "$TMP/status")" = "409" ] || { echo "registro inesperado"; exit 1; }
ok "registro demo@example.com (201 nuevo / 409 si ya existia)"
api POST /auth/login "" '{"email":"demo@example.com","password":"Dem0!Passw0rd-larga"}'
expect 200 "login demo"
ACCESS="$(jget "['accessToken']")"
REFRESH="$(jget "['refreshToken']")"
api GET /users/me "$ACCESS"
expect 200 "perfil propio sin hash"
python3 -c "import json; b=json.load(open('$TMP/body')); assert 'password_hash' not in b, b" && ok "respuesta sin password_hash"

step "2. refresh rotativo: el viejo muere, el reuso falla cerrado"
api POST /auth/refresh "" "{\"refresh_token\":\"$REFRESH\"}"
expect 200 "rotacion"
NEW_REFRESH="$(jget "['refreshToken']")"
[ "$NEW_REFRESH" != "$REFRESH" ] && ok "token nuevo distinto"
api POST /auth/refresh "" "{\"refresh_token\":\"$REFRESH\"}"
expect 401 "reuso del viejo: 401 (falla cerrado)"
api POST /auth/refresh "" "{\"refresh_token\":\"$NEW_REFRESH\"}"
expect 200 "la familia sigue viva (el reuso reciente no la nukea)"

step "3. MFA: alta, confirmacion y login en dos pasos"
api POST /mfa/setup "$ACCESS"
expect 200 "setup devuelve secreto"
SECRET="$(jget "['secret']")"
CODE="$(totp "$SECRET")"
api POST /mfa/confirm "$ACCESS" "{\"code\":\"$CODE\"}"
expect 200 "confirm activa MFA"
python3 -c "import json; assert len(json.load(open('$TMP/body'))['recoveryCodes'])==10" && ok "10 recovery codes (una sola vez)"
api POST /auth/login "" '{"email":"demo@example.com","password":"Dem0!Passw0rd-larga"}'
expect 200 "login con MFA devuelve ticket, no sesion"
python3 -c "import json; b=json.load(open('$TMP/body')); assert b.get('mfaRequired') is True and b.get('mfaTicket'), b" && ok "mfaRequired + mfaTicket (sin accessToken)"
TICKET="$(jget "['mfaTicket']")"
api POST /auth/mfa/verify "" "{\"ticket\":\"$TICKET\",\"code\":\"$(totp "$SECRET")\"}"
expect 200 "verify con TOTP"
MFA_ACCESS="$(jget "['accessToken']")"
[ "$(jwt_claim "$MFA_ACCESS")" = "True" ] && ok "access con claim mfa:true"

step "4. RBAC: 403 por rol, 403 por falta de MFA"
api GET /admin/users "$USER_TOKEN"
expect 403 "usuario comun en /admin/users"
python3 -c "import json; assert json.load(open('$TMP/body'))['error']['code']=='forbidden'" && ok "code=forbidden"
api POST /auth/login "" "{\"email\":\"admin@example.com\",\"password\":\"$PASS\"}"
expect 200 "login admin (seed, sin MFA)"
ADMIN_TOKEN="$(jget "['accessToken']")"
api GET /admin/users "$ADMIN_TOKEN"
expect 403 "admin sin MFA en /admin/users"
python3 -c "import json; assert json.load(open('$TMP/body'))['error']['code']=='mfa_required'" && ok "code=mfa_required"

step "5. admin con MFA: 200 en /admin/users"
api POST /mfa/setup "$ADMIN_TOKEN"
ASECRET="$(jget "['secret']")"
api POST /mfa/confirm "$ADMIN_TOKEN" "{\"code\":\"$(totp "$ASECRET")\"}"
expect 200 "MFA activado para admin"
ATICKET="$(api POST /auth/login "" "{\"email\":\"admin@example.com\",\"password\":\"$PASS\"}" && jget "['mfaTicket']")"
api POST /auth/mfa/verify "" "{\"ticket\":\"$ATICKET\",\"code\":\"$(totp "$ASECRET")\"}"
ADMIN_MFA="$(jget "['accessToken']")"
api GET /admin/users "$ADMIN_MFA"
expect 200 "admin + MFA lista usuarios"

echo
echo "DEMO OK: todos los controles verificados en vivo."
