# servicio-login (simple)

Login basico: registro + login con JWT, SQLite en archivo local.
Sin MFA, sin refresh, sin roles, sin rate limiting, sin auditoria:
esa capa la implementa el equipo.

## Quickstart (solo npm)

```bash
npm install
cp .env.example .env   # completar JWT_SECRET (openssl rand -hex 32)
npm run db:migrate
SEED_PASSWORD='...' npm run db:seed   # crea demo@example.com (opcional)
npm run dev
```

Swagger: `http://localhost:3000/docs`.

## Endpoints

| Metodo | Ruta | Que hace |
|---|---|---|
| GET | /health | 200 `{status:"ok"}` |
| POST | /auth/register | 201 `{id,email}` / 409 email en uso |
| POST | /auth/login | 200 `{accessToken}` / 401 generico |

Password: minimo 12 caracteres, 3 de 4 clases. Hash argon2id.
JWT HS256 con `sub` = id de usuario, expira en `ACCESS_TTL_MINUTES`.

## Estructura

```
src/
  app.ts server.ts  config/env.ts  docs/openapi.ts
  shared/{db (sqlite + migraciones), crypto (argon2, jwt), http, errors.ts, logger.ts}
  modules/auth/  (routes, service, repository, sqlite-repository, schema, types)
```

El `service` no conoce HTTP ni SQL: se testea con un fake en memoria.
`app.ts` es el unico lugar donde se conectan las piezas.

## Tests

`npm test` — unitarios con fakes + integracion contra SQLite en memoria.
