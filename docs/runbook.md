# Runbook — servicio-login (simple)

## Arranque local

```bash
npm install
cp .env.example .env   # completar JWT_SECRET
npm run db:migrate
SEED_PASSWORD='<12+ caracteres>' npm run db:seed   # opcional
npm run dev            # o: npm run build && npm start
```

## Base de datos

SQLite en `DB_PATH` (default `./data/login.db`, ignorado por git).
Backup = copiar el archivo con el servidor detenido.

## Migraciones

`npm run db:migrate`: aplica `src/shared/db/migrations/*.sql` en orden,
transaccional por archivo, idempotente. Nueva migracion: `NNN_nombre.sql`.

## Rotacion de JWT_SECRET (requiere reinicio)

Cambiar el valor y reiniciar: los tokens viejos mueren (max `ACCESS_TTL_MINUTES`).

## Logs

JSON por stdout. `sanitize()` redacta claves sensibles (password, token, ...).
