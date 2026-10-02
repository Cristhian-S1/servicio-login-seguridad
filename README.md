# servicio-login-seguridad

Servicio de autenticacion autocontenido (API + Swagger, sin frontend):
registro con argon2id, access JWT + refresh rotativo con deteccion de reuso,
MFA TOTP + recovery codes, rate limiting, auditoria y RBAC. Docker local hoy,
estructura lista para endurecer (VM/k8s) sin reescribir.

## Quickstart

```bash
cp .env.example .env   # completar secretos
docker compose up --build -d
npm run db:migrate
SEED_PASSWORD='...' npm run db:seed
BASE=http://localhost:3000 SEED_PASSWORD='...' ./scripts/demo-defensa.sh
```

Swagger: `http://localhost:3000/docs`.

## Endpoints

| Metodo | Ruta | Auth | Que hace |
|---|---|---|---|
| GET | /health | - | 200 `{status:"ok"}` |
| POST | /auth/register | - | 201 `{id,email}` / 409 email en uso |
| POST | /auth/login | - | tokens, o `{mfaRequired,mfaTicket}` |
| POST | /auth/refresh | - | rota el par; reuso = 401 |
| POST | /auth/logout | Bearer | revoca la familia (204) |
| POST | /auth/mfa/verify | ticket | paso 2: tokens con `mfa:true` |
| POST | /mfa/setup | Bearer | `{secret,otpauthUrl}` |
| POST | /mfa/confirm | Bearer | activa MFA, 10 recovery codes (una vez) |
| GET | /users/me | Bearer | perfil sin hash |
| GET | /admin/users | admin+MFA | lista usuarios |

## Estructura (patron por modulo)

Cada modulo: `routes` (solo HTTP) · `service` (logica, sin express/pg) ·
`repository` (interface) · `pg-repository` (SQL) · `schema` (zod) · `types`.
Reglas: el service no importa express ni pg; `app.ts` es el unico wiring;
secretos por entorno validado al arranque.

```
src/
  app.ts server.ts  config/env.ts
  shared/{db,crypto,http,errors.ts,logger.ts}
  modules/{auth,users,sessions,mfa,audit}/
docs/  security.md (amenazas)  runbook.md (operacion)
```

## Para la defensa (donde mirar)

- Rotacion atomica + nuke por reuso: `src/modules/sessions/sessions.service.ts`
- Login que miente por diseno (401 generico): `src/modules/auth/auth.service.ts`
- MFA en dos pasos sin sesion prematura: `src/modules/mfa/mfa.service.ts`
- Matriz RBAC con `mfa:true` para admin: `src/modules/users/users.routes.ts`
- Secretos fuera de logs/respuestas: `src/shared/logger.ts` + tests `*-filtration`
- Endurecimiento sin reescribir: `Dockerfile`, `docker-compose.yml`, `docs/security.md`

Diseno completo: `arquitectura.txt`. Plan: `plan-implementacion.txt`.
