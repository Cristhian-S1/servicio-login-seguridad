# servicio-login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a modular Node.js + TypeScript login API (register, JWT access + rotating refresh, TOTP MFA, rate limiting, audit, RBAC) runnable with Docker Compose locally.

**Architecture:** Monolith modular por feature: cada modulo (`auth`, `users`, `sessions`, `mfa`, `audit`) tiene routes (HTTP only), service (sin express ni pg), repository (interface), pg-repository (SQL), schema (zod), types. `src/app.ts` is the only composition root.

**Tech Stack:** Node 22 + TypeScript (tsc build, tsx dev), express, pg (raw SQL, no ORM), argon2 (argon2id), jsonwebtoken (HS256), otplib (TOTP), zod, helmet, express-rate-limit (memory store), swagger-ui-express, vitest + supertest + testcontainers (tests), postgres:16 (docker).

**Spec:** `arquitectura.txt` in repo root (sections 1–14). The plan argues from the spec; executors read both.

## Global Constraints

- All secrets via environment validated by `src/config/env.ts` (zod); process dies on missing/insecure values.
- `JWT_SECRET` minimum 32 bytes; the example value from `.env.example` is rejected.
- Password hashing: argon2id, OWASP params in prod (memory 19456 KiB, time 2, parallelism 1), low params in tests via env.
- Access JWT TTL 15 min (`sub`, `role`, `mfa` claims); refresh token opaque 32 random bytes, stored as SHA-256, TTL 30 days; MFA ticket JWT TTL 5 min with `scope: "mfa"`.
- Login/MFA failures return generic 401 `invalid_credentials`; register duplicate returns 409 `email_taken`.
- Never log passwords, tokens, TOTP secrets, or recovery codes; never return password hashes or raw refresh tokens in responses.
- `service.ts` files import neither `express` nor `pg` — only repository interfaces.
- Each request carries a `requestId` in logs and response header.
- Commits: one per task, `feat:`/`test:`/`chore:` prefix.

## Review Focus

- Email with uppercase / trailing spaces registers, then login with lowercase fails → normalize (trim + lowercase) in schema; test in Task 4.
- Two concurrent `/auth/refresh` calls with the same token both succeed (race creates two families) → `SELECT ... FOR UPDATE` on the token row; test in Task 6.
- TOTP code from a phone with ±30s clock drift rejected → verify with `window: 1`; test in Task 7.
- `Authorization: Bearer` malformed (missing scheme, empty token) crashes or 500s → `requireAuth` returns 401 on any malformed header; test in Task 5.
- Oversized JSON body / malformed JSON kills the handler → `express.json({ limit: "100kb" })` + syntax-error → 400 via errorHandler; test in Task 1.

---

### Task 1: Base, config, errors, health

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/config/env.ts`, `src/shared/errors.ts`, `src/shared/http/asyncHandler.ts`, `src/shared/http/errorHandler.ts`, `src/shared/http/requestId.ts`, `src/shared/logger.ts`, `src/app.ts`, `src/server.ts`
- Test: `tests/unit/env.test.ts`, `tests/integration/health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadEnv() -> Env` (throws on invalid); `AppError` subclasses (`ValidationError`, `AuthError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `InternalError`); `asyncHandler(fn)`; `createApp() -> express.Express` with `GET /health -> 200 { status: "ok" }`.

- [ ] **Step 1: Write failing tests** — `tests/unit/env.test.ts`: `loadEnv()` throws when `JWT_SECRET` missing or <32 bytes; `tests/integration/health.test.ts`: `GET /health` returns 200 with `{ status: "ok" }` and `x-request-id` header.
- [ ] **Step 2: Run to verify they fail** — Run: `npx vitest run tests/unit/env.test.ts tests/integration/health.test.ts`. Expected: FAIL (modules not defined).
- [ ] **Step 3: Implement** — `package.json` (express, zod; dev: typescript, vitest, supertest, tsx), `tsconfig.json` (strict, outDir dist), `env.ts` (zod schema: `DATABASE_URL`, `JWT_SECRET` min 32 and not equal to example sentinel, `ACCESS_TTL_MINUTES` default 15, `REFRESH_TTL_DAYS` default 30, `ARGON_*`, `RATE_LIMIT_*`), `errors.ts` hierarchy, `asyncHandler`, `errorHandler` (AppError → status; `SyntaxError` from body-parser → 400 `validation_error`; else 500 `internal_error`), `requestId` middleware, `logger` (pino or console wrapper with `sanitize()` dropping `password`, `token`, `secret`, `code` keys), `app.ts` (`helmet()`, `express.json({ limit: "100kb" })`, requestId, routes, errorHandler), `server.ts` (listen + graceful shutdown).
- [ ] **Step 4: Run tests** — Run: `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: base app, env validation, errors, health"`

### Task 2: Postgres pool + migrations + users table

**Files:**
- Create: `src/shared/db/pool.ts`, `src/shared/db/migrate.ts`, `src/shared/db/migrations/001_users.sql`, `scripts/migrate.ts`
- Test: `tests/integration/migrate.test.ts` (uses testcontainers postgres:16)

**Interfaces:**
- Consumes: `loadEnv()` from Task 1.
- Produces: `getPool() -> pg.Pool` (singleton); `runMigrations(pool)` (applies pending `.sql` files, tracks in `schema_migrations`); migration 001 creates `users` table per spec §9.

- [ ] **Step 1: Write failing test** — `tests/integration/migrate.test.ts`: after `runMigrations`, `users` table exists with unique constraint on `email` (insert duplicate → error code `23505`).
- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run tests/integration/migrate.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — `pool.ts` (singleton `pg.Pool` from `DATABASE_URL`, `max 10`), `migrate.ts` (reads `migrations/*.sql` in order, `CREATE TABLE IF NOT EXISTS schema_migrations`, runs each in a transaction, records filename), `001_users.sql` (columns per spec §9: `id uuid PK default gen_random_uuid()`, `email varchar(320) unique not null`, `password_hash text not null`, `role text default 'user' check`, `is_active bool default true`, `mfa_enabled bool default false`, `created_at/updated_at`; needs `pgcrypto` for `gen_random_uuid()`), `scripts/migrate.ts` runnable via `tsx` with `npm run db:migrate`.
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/integration/migrate.test.ts` (needs Docker for testcontainers). Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: postgres pool, migration runner, users table"`

### Task 3: Audit module

**Files:**
- Create: `src/modules/audit/audit.types.ts`, `audit.repository.ts`, `audit.pg-repository.ts`, `audit.service.ts`, `src/shared/db/migrations/002_audit.sql`
- Test: `tests/unit/audit.service.test.ts` (fake repo), `tests/integration/audit.pg-repository.test.ts`

**Interfaces:**
- Consumes: `getPool()` (Task 2).
- Produces: `AuditRepository { append(event: AuditEventInput): Promise<void> }`; `AuditService { record(type, { userId?, ip?, metadata? }): Promise<void> }`; event types union per spec §9 (`register`, `login_success`, `login_failure`, `refresh`, `refresh_reuse_detected`, `mfa_enabled`, `mfa_success`, `mfa_failure`).

- [ ] **Step 1: Write failing tests** — unit: `record()` calls repo `append` with `occurred_at` set; integration: row lands in `audit_events` with correct `event_type` and nullable `user_id`.
- [ ] **Step 2: Run to verify they fail** — Run: `npx vitest run tests/unit/audit.service.test.ts tests/integration/audit.pg-repository.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — types, interface, pg implementation (`INSERT INTO audit_events ...`), service (fills `occurred_at = new Date()`), migration 002 (`audit_events` table + indexes per spec §9).
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/unit/audit.service.test.ts tests/integration/audit.pg-repository.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: audit module with pg repository"`

### Task 4: Auth register

**Files:**
- Create: `src/shared/crypto/password.ts`, `src/modules/auth/auth.types.ts`, `auth.schema.ts`, `auth.repository.ts`, `auth.pg-repository.ts`, `auth.service.ts`, `auth.routes.ts`
- Modify: `src/app.ts` (mount `/auth`), `src/shared/db/migrations/001_users.sql` only if needed (no — users exists)
- Test: `tests/unit/auth.service.test.ts` (fake `AuthRepository` + fake audit), `tests/integration/auth.register.test.ts`

**Interfaces:**
- Consumes: `AuditService` (Task 3).
- Produces: `AuthService { register(input: { email, password }): Promise<{ id, email }> }` throwing `ConflictError("email_taken")` on duplicate; `POST /auth/register` → 201 `{ id, email }`, 400 on invalid, 409 on duplicate. Password policy in zod: min 12 chars, at least 3 of 4 classes (lower/upper/digit/symbol).

- [ ] **Step 1: Write failing tests** — unit: register ok normalizes email (`"  User@X.com "` → `user@x.com`); duplicate email throws `ConflictError`; weak password rejected by schema; integration: `POST /auth/register` 201 then same email 409; response contains no `password_hash`.
- [ ] **Step 2: Run to verify they fail** — Run: `npx vitest run tests/unit/auth.service.test.ts tests/integration/auth.register.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — `password.ts` (`hashPassword`/`verifyPassword` with argon2id, params from env), schema (email trim+lowercase transform, password policy refinement), repository interface (`findByEmail`, `create`), pg implementation (map `23505` → let service throw `ConflictError`), service (normalize → check exists → hash → create → `audit.record("register")`), routes (validate → service → 201).
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/unit/auth.service.test.ts tests/integration/auth.register.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: auth register with argon2id"`

### Task 5: Auth login + requireAuth

**Files:**
- Create: `src/shared/crypto/jwt.ts`, `src/shared/http/requireAuth.ts`
- Modify: `src/modules/auth/auth.service.ts` (add `login`), `auth.routes.ts` (add `POST /auth/login`), `auth.schema.ts`
- Test: `tests/unit/auth.login.test.ts`, `tests/integration/auth.login.test.ts`

**Interfaces:**
- Consumes: `AuthService.register`, `AuditService` (Tasks 3–4).
- Produces: `AuthService.login({ email, password, ip }) -> { accessToken, refreshToken } | { mfaRequired, mfaTicket }` (ticket branch wired in Task 7; for now returns tokens only when `mfa_enabled=false`, else throws `ForbiddenError("mfa_required")` placeholder? No — implement ticket now via `jwt.ts`: simpler to implement `issueMfaTicket(userId)` here and consume in Task 7); `signAccessToken({ sub, role, mfa })`; `requireAuth` middleware (`req.user = { sub, role, mfa }`, 401 on missing/malformed/invalid).

- [ ] **Step 1: Write failing tests** — unit: correct password + `mfa_enabled=false` returns both tokens; wrong password throws `AuthError`, `login_failure` audited; nonexistent email also throws identical `AuthError` (no enumeration); inactive user throws `AuthError`; integration: `POST /auth/login` 200 with tokens, wrong password 401 same body shape; malformed `Authorization` header → 401 (Review Focus #4).
- [ ] **Step 2: Run to verify they fail** — Run: `npx vitest run tests/unit/auth.login.test.ts tests/integration/auth.login.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — `jwt.ts` (`signAccessToken` HS256 15m; `issueMfaTicket` 5m `scope: "mfa"`; `verifyToken`), service `login` (normalize → find → if missing, still run `verifyPassword` against dummy hash? No — just throw generic `AuthError`; check `is_active`; `verifyPassword`; if `mfa_enabled` return `{ mfaRequired: true, mfaTicket }`; else issue pair + audit `login_success`/`login_failure`), `requireAuth` (parse `Bearer`, verify, attach user, 401 otherwise), routes.
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/unit/auth.login.test.ts tests/integration/auth.login.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: auth login with JWT access and requireAuth"`

### Task 6: Sessions (refresh rotation + reuse detection)

**Files:**
- Create: `src/modules/sessions/sessions.types.ts`, `sessions.schema.ts`, `sessions.repository.ts`, `sessions.pg-repository.ts`, `sessions.service.ts`, `sessions.routes.ts`, `src/shared/db/migrations/003_sessions.sql`
- Test: `tests/unit/sessions.service.test.ts` (fake repo), `tests/integration/sessions.test.ts`

**Interfaces:**
- Consumes: `signAccessToken` (Task 5), `AuditService` (Task 3), `AuthRepository.findById` (extend interface in this task).
- Produces: `SessionsService { createSession(userId, ip) -> { refreshToken }; refresh(rawToken, ip) -> { accessToken, refreshToken }; revokeFamily(userId) }`; `POST /auth/refresh { refresh_token }` → 200 new pair; `POST /auth/logout` (auth required, revokes presenting family? simplest: revokes all user sessions) → 204.

- [ ] **Step 1: Write failing tests** — unit (fake repo): valid refresh rotates (old marked revoked with `replaced_by`, new issued); expired → `AuthError`; reused rotated token → whole family revoked + `refresh_reuse_detected` audited; integration: login → refresh → old token reuse → 401 and subsequent refresh with the new token also 401 (family dead); concurrent refresh race → only one succeeds (Review Focus #2, pg test with two parallel calls).
- [ ] **Step 2: Run to verify they fail** — Run: `npx vitest run tests/unit/sessions.service.test.ts tests/integration/sessions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — migration 003 (`refresh_tokens` per spec §9); `randomToken()` via `crypto.randomBytes(32)`; store `sha256(raw)`; service `refresh`: `SELECT ... FOR UPDATE` by hash → checks (exists, not revoked, not expired) → if `replaced_by` set → `revokeFamily` + audit `refresh_reuse_detected` + throw; else revoke old, insert new, return pair; pg-repository with `revokeFamily(userId)` (`UPDATE ... SET revoked_at=now() WHERE user_id AND revoked_at IS NULL`); routes.
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/unit/sessions.service.test.ts tests/integration/sessions.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: sessions with refresh rotation and reuse detection"`

### Task 7: MFA (TOTP + recovery codes)

**Files:**
- Create: `src/modules/mfa/mfa.types.ts`, `mfa.schema.ts`, `mfa.repository.ts`, `mfa.pg-repository.ts`, `mfa.service.ts`, `mfa.routes.ts`, `src/shared/db/migrations/004_mfa.sql`
- Modify: `src/modules/auth/auth.routes.ts` (add `POST /auth/mfa/verify`), `src/modules/users` not yet — skip
- Test: `tests/unit/mfa.service.test.ts`, `tests/integration/mfa.test.ts`

**Interfaces:**
- Consumes: `issueMfaTicket`/`verifyToken` (Task 5), `SessionsService.createSession` (Task 6), `AuditService` (Task 3).
- Produces: `MfaService { setup(userId) -> { otpauthUrl, secret }; confirm(userId, code) -> { recoveryCodes: string[] }; verifyTicket(ticket, code, ip) -> { accessToken, refreshToken }; consumeRecoveryCode(userId, code): Promise<boolean> }`; routes: `POST /mfa/setup`, `POST /mfa/confirm`, `POST /auth/mfa/verify`.

- [ ] **Step 1: Write failing tests** — unit: `setup` returns `otpauth://totp/...` URL; `confirm` with valid code (generated with same secret) enables + returns 10 codes, wrong code throws `AuthError`; recovery code works once, second use fails; integration: full flow register → login (mfa ticket) → verify → tokens with `mfa:true` claim; drifted clock code (±30s) accepted via window 1 (Review Focus #3); 3 wrong codes → audit `mfa_failure` entries.
- [ ] **Step 2: Run to verify they fail** — Run: `npx vitest run tests/unit/mfa.service.test.ts tests/integration/mfa.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — migration 004 (`mfa_secrets`, `recovery_codes` per spec §9); TOTP via `otplib.authenticator` (`window: 1`); secret `authenticator.generateSecret()`; recovery codes: 10 × `randomBytes(9)` base64url, stored hashed (reuse `hashPassword`? No — SHA-256 with per-code salt is enough; simplest: argon2id via `password.ts` for consistency, 10 hashes is slow but one-time; choose SHA-256 + random salt column? Keep argon2id, one-time cost is fine); `users.mfa_enabled` flip in `confirm`; routes (setup/confirm require auth; verify is public with ticket).
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/unit/mfa.service.test.ts tests/integration/mfa.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: TOTP MFA with recovery codes"`

### Task 8: Users + RBAC

**Files:**
- Create: `src/modules/users/users.types.ts`, `users.repository.ts`, `users.pg-repository.ts` (reuse `AuthRepository`? No — own `findById`, `list`), `users.service.ts`, `users.routes.ts`, `src/shared/http/requireRole.ts`, `src/shared/http/requireMfa.ts`
- Test: `tests/unit/users.service.test.ts`, `tests/integration/rbac.test.ts`

**Interfaces:**
- Consumes: `requireAuth` (Task 5).
- Produces: `GET /users/me` → 200 `{ id, email, role, mfa_enabled }` (never hash); `GET /admin/users` (requires `admin` + `mfa:true`) → 200 list; `requireRole("admin")`, `requireMfa` middlewares.

- [ ] **Step 1: Write failing tests** — integration matrix: no token → 401; user token on `/admin/users` → 403; admin token with `mfa:false` → 403 `mfa_required`; admin with `mfa:true` → 200; `/users/me` returns no `password_hash`.
- [ ] **Step 2: Run to verify they fail** — Run: `npx vitest run tests/unit/users.service.test.ts tests/integration/rbac.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — service (`getMe`, `listUsers`), pg repo, middlewares, routes; mount `/users` and `/admin` in `app.ts`.
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/unit/users.service.test.ts tests/integration/rbac.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: users profile and admin RBAC"`

### Task 9: Rate limiting

**Files:**
- Create: `src/shared/http/rateLimit.ts`
- Modify: `src/app.ts` (apply limiters)
- Test: `tests/integration/rate-limit.test.ts`

**Interfaces:**
- Consumes: `AuditService` (Task 3), `RateLimitError` (Task 1).
- Produces: `loginLimiter` (key = ip + normalized email, 5 attempts / 15 min window) applied to `POST /auth/login` and `POST /auth/mfa/verify`; `globalLimiter` (100 req / 15 min per IP) applied app-wide; 429 `{ error: { code: "rate_limited" } }` + `Retry-After` header.

- [ ] **Step 1: Write failing test** — 6th login attempt within window → 429 with `Retry-After`; different email from same IP still allowed (key includes email).
- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run tests/integration/rate-limit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — `express-rate-limit` memory stores with `keyGenerator` (login: `${ip}:${email}`, global: ip), custom `handler` throwing `RateLimitError`, limits from env (`RATE_LIMIT_LOGIN_MAX`, `RATE_LIMIT_LOGIN_WINDOW_MS`, `RATE_LIMIT_GLOBAL_*`); failed attempts already audited by services.
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/integration/rate-limit.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: rate limiting on login and global"`

### Task 10: OpenAPI / Swagger

**Files:**
- Create: `src/docs/openapi.ts` (or `openapi.json`), mount in `src/app.ts`
- Test: `tests/integration/docs.test.ts`

**Interfaces:**
- Consumes: all routes (Tasks 4–9).
- Produces: `GET /docs` (swagger-ui) and `GET /docs.json` (raw spec) covering every endpoint with request/response schemas and security schemes (bearerAuth).

- [ ] **Step 1: Write failing test** — `GET /docs` → 200 HTML; `GET /docs.json` → 200 with paths for `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/mfa/verify`, `/mfa/setup`, `/mfa/confirm`, `/users/me`, `/admin/users`.
- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run tests/integration/docs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** — hand-written OpenAPI 3.0 spec mirroring the zod schemas (no codegen to keep v1 simple), served by `swagger-ui-express`.
- [ ] **Step 4: Run tests** — Run: `npx vitest run tests/integration/docs.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: swagger docs"`

### Task 11: Docker

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`
- Test: manual verification (no automated test): `docker compose up --build`, `npm run db:migrate`, seed register via curl, `GET /health` 200.

**Interfaces:**
- Consumes: `npm run build` (`tsc`), `npm run db:migrate` (Task 2), `GET /health` (Task 1).
- Produces: `api` image (multi-stage, `node:22-slim`, `USER node`, no source) + `db` (postgres:16, named volume, `pg_isready` healthcheck) + `mailpit` (reserved) on `app-net`; only `api` publishes a host port; `depends_on: service_healthy`.

- [ ] **Step 1: Write the verification checklist** — image runs as non-root (`docker exec whoami` → `node`); `GET /health` 200; killing `db` then restarting keeps data (volume); `.env` not present in image (`docker exec cat .env` fails).
- [ ] **Step 2: Run checklist to verify it fails** — without files, `docker compose up` errors. Expected: FAIL.
- [ ] **Step 3: Implement** — `Dockerfile` (deps → build → runtime), `docker-compose.yml`, `.dockerignore` (`node_modules`, `dist`? No — dist is built inside; ignore `src` tests, `.env`, git), `.env.example` (all vars, fake values, `JWT_SECRET` = `CHANGE_ME_...` sentinel rejected by env validation).
- [ ] **Step 4: Run checklist to verify it passes** — Run full `docker compose up --build` + migrate + curl register/login. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "chore: docker multi-stage and compose"`

### Task 12: Seed, demo script, docs, README

**Files:**
- Create: `scripts/seed.ts`, `scripts/demo-defensa.sh`, `docs/security.md`, `docs/runbook.md`, `README.md`
- Test: `scripts/demo-defensa.sh` runs green against a fresh `docker compose` stack (its own exit code is the test).

**Interfaces:**
- Consumes: everything (Tasks 1–11), spec §14 for `security.md`.
- Produces: `npm run db:seed` (admin `admin@example.com` + user `user@example.com`, password from env `SEED_PASSWORD`, MFA enabled on admin? No — keep seed simple: two users, no MFA; demo script enables MFA live); `demo-defensa.sh` (register → login → refresh → reuse-detection → MFA setup/verify → RBAC 403/200, printing each step); docs per spec §§13–14; README (quickstart, endpoints table, defense talking points mapping to code locations).

- [ ] **Step 1: Write the demo script skeleton** — with `set -euo pipefail` and assertion helper (`expect_status 200 ...`); run against empty stack.
- [ ] **Step 2: Run to verify it fails** — Run: `./scripts/demo-defensa.sh`. Expected: FAIL (no seed, no helpers).
- [ ] **Step 3: Implement** — `seed.ts` (idempotent upsert by email), full `demo-defensa.sh` (curl flow with `jq` checks, including reuse-detection revoking the family and RBAC matrix), `docs/security.md` (spec §14 verbatim structure), `docs/runbook.md` (migrate, backup `docker volume`, secret rotation with dual-secret list `JWT_SECRETS`? No — v1: rotation requires restart; document it), `README.md`.
- [ ] **Step 4: Run demo to verify it passes** — Run: fresh `docker compose up`, `npm run db:migrate`, `npm run db:seed`, `./scripts/demo-defensa.sh`. Expected: exit 0, all steps green.
- [ ] **Step 5: Commit** — `git commit -m "chore: seed, defense demo script, docs, readme"`

## Self-Review

- **Spec coverage:** §3 layout → Tasks 1–3, 11; §4 module pattern + 3 rules → Tasks 3–8 (verified by unit-with-fake tests); §9 data model → migrations in Tasks 2, 3, 6, 7; §10 flows → Tasks 4–8; §11 errors → Tasks 1, 5; §12 testing → every task; §13 deploy → Task 11; §14 threats → Task 12 docs + reuse-detection (Task 6) + no-leak tests (Tasks 4, 5). Gap found and fixed: `AuthRepository.findById` needed by sessions (Task 6 extends the interface — noted in Consumes).
- **Step scan:** each step names one action with a checkable result; no bodies transcribed (implementers write bodies from signatures + tests).
- **Type consistency:** `AuthService.login` return union consumed by routes (Task 5) and extended by MFA verify (Task 7 uses `verifyTicket`, not login — consistent); `AuditService.record(type, opts)` signature stable across Tasks 3–9.
- **Review Focus:** all 5 items have owning tests (Tasks 1, 4, 5, 6, 7).
- **Proportion:** 12 tasks for ~14 spec sections; test sketches and signatures only, no full implementations.
