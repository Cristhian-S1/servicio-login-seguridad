# AGENTS.md

Minimal login API: Node + TypeScript + Express 4 + SQLite. Modular monolith by
feature (`src/modules/<feature>/`). Endpoints: `GET /health`,
`POST /auth/register`, `POST /auth/login` (JWT HS256), `GET /docs` (Swagger),
and `GET /` (static verification frontend).

## Commands

- `npm install`
- `npm run dev` — `tsx src/server.ts`
- `npm run build` — `tsc` **then copies migrations and `public/` into `dist/`**.
  Do not run `tsc` alone: `getDb()` resolves migrations next to compiled
  `sqlite.js` and the frontend is served from `dist/public/`, so a build without
  the `cp`s breaks both.
- `npm start` — `node dist/src/server.js` (note `dist/src/...`; tsconfig also
  includes `scripts/`, so tsc's root is the repo root).
- `npm test` — `vitest run` (no config file, default discovery).
- Single test: `npx vitest run tests/unit/env.test.ts` (or `-t "<name>"`).
- Typecheck: `npx tsc --noEmit`. There is **no** `lint` or `typecheck` script.
- `npm run db:migrate`; seed: `SEED_PASSWORD='<12+ chars>' npm run db:seed`.
- VM automation (bash, idempotent): `npm run vm:setup` (`.env` + build + migrate +
  systemd + optional `IP_CIDR=...`), `npm run deploy` (pull + rebuild + restart),
  `npm run ip:persist` (persist a secondary IP). Details: `docs/despliegue-vm.md`.

## Environment (non-obvious)

- There is **no `dotenv`** and scripts don't pass `--env-file`: `.env` is NOT
  auto-loaded, even though `README.md`/`docs/runbook.md` say to `cp .env.example
  .env`. Export vars in the shell (e.g. `set -a; . ./.env; set +a`) or run
  `node --env-file=.env`, or the process throws `Invalid environment`.
- `JWT_SECRET` must be >= 32 chars and not the `.env.example` sentinel, or
  `loadEnv()` throws at startup.
- Tests set `process.env` inline (low argon params) and use in-memory SQLite;
  they need no `.env`. `resolveDbPath()` keeps `DB_PATH=:memory:` in memory
  instead of turning it into a file named `:memory:`.
- Env is read directly from `process.env` in `config/env.ts`, `crypto/jwt.ts`
  (caches config on first use), and `crypto/password.ts` — not only via `loadEnv`.

## Architecture / conventions to preserve

- `src/app.ts` is the only composition root. `createApp(deps?)` accepts a
  partial `AppDeps` so tests inject an in-memory repo. `src/server.ts` is the
  entrypoint.
- Layering per feature: `routes` (HTTP + zod parse) → `service` (no express,
  no SQL) → `AuthRepository` interface → `SqliteAuthRepository`. `service`
  takes the repository via constructor; keep this when adding modules.
- Migrations: `src/shared/db/migrations/NNN_name.sql`, applied in lexical order,
  transactional per file, tracked in `schema_migrations` (idempotent). `getDb()`
  does NOT auto-migrate; `runMigrations()` is called explicitly by the migrate
  script, seed, and tests.
- Email is normalized (`trim().toLowerCase()`) in `auth.schema.ts` and again in
  `auth.service.ts`.
- Frontend: single static `public/index.html` (vanilla HTML/CSS/JS, no build step,
  no deps) served by `express.static(join(__dirname, "../public"))` in `app.ts`;
  the build copies it to `dist/public/`. It only calls same-origin endpoints.
- Deployment on the Kubuntu VM (systemd unit, env gotcha, pending IP persistence):
  `docs/despliegue-vm.md`.
- Logger `sanitize()` redacts any key containing
  `password|token|secret|code|auth|hash|recovery|ticket`; keep secrets out of
  responses/logs (there are contract tests for this).
- User-facing messages are in Spanish; keep that style.

## Stale docs

`arquitectura.txt` and `plan-implementacion.txt` describe the FULL target
system (Postgres, MFA, refresh, RBAC, rate limiting, docker-compose,
`docs/security.md`). The code is the "simplified v2" (see `arquitectura.txt`
section 15): SQLite, register + login only. The removed security layer is meant
to be implemented by the team on this base — don't wire it from the docs unless
asked.

The repo is currently not a git repository (no `.git`).

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
