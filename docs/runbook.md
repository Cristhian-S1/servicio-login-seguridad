# Runbook — servicio-login

## Arranque local

```bash
cp .env.example .env        # completar POSTGRES_PASSWORD y JWT_SECRET (openssl rand -hex 32)
docker compose up --build -d
npm run db:migrate
SEED_PASSWORD='<12+ caracteres>' npm run db:seed
```

## Migraciones

- `npm run db:migrate`: aplica `src/shared/db/migrations/*.sql` en orden,
  registrando en `schema_migrations`. Idempotente y transaccional por archivo.
- Nueva migracion: archivo `NNN_nombre.sql` con `CREATE TABLE IF NOT EXISTS`
  + indices. Nunca editar una migracion ya aplicada en un entorno vivo.

## Backup

```bash
docker compose exec db pg_dump -U login login > backup-$(date +%F).sql
docker volume ls | grep pgdata   # el volumen nombrado es lo que persiste
```

Restaurar: `cat backup.sql | docker compose exec -T db psql -U login login`.

## Rotacion de JWT_SECRET (v1: requiere reinicio)

1. Generar nuevo secreto, actualizar `.env` / gestor de secretos.
2. `docker compose up -d --force-recreate api`.
3. Efecto: todos los access tokens mueren (15 min max); los refresh siguen
   validos (opacos, no dependen del secreto). Comunicar ventana de re-login.

## Logs y auditoria

- Logs: JSON por stdout (`docker compose logs api`), sin secretos (`sanitize`).
- Auditoria forense: tabla `audit_events`
  (`SELECT event_type, COUNT(*) ... WHERE occurred_at > now() - interval '1 day'`).

## Problemas comunes

| Sintoma | Causa probable |
|---|---|
| El api muere al arrancar: `Invalid environment` | `.env` incompleto o `JWT_SECRET` debil/corto |
| 401 en todo | reloj desfasado (JWT `exp`) o secreto rotado |
| 429 prematuro en demo | bajar `RATE_LIMIT_*` solo en local, nunca en prod |
| `docker compose up` sin red | recrear: `docker compose down && docker compose up --build` |
