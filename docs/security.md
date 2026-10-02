# Modelo de amenazas y controles — servicio-login

Declaracion honesta de que atacantes se consideran, con que se frenan,
y que queda explicitamente fuera. Cada control mapea a codigo verificable.

## 1. Fuerza bruta / credential stuffing

- Rate limiting por IP + email en login (`src/shared/http/rateLimit.ts`):
  429 + `Retry-After`. Clave `ip:email` para no bloquear usuarios legitimos.
- argon2id (OWASP: m=19456 KiB, t=2, p=1) hace cada intento caro en CPU
  (`src/shared/crypto/password.ts`).
- Cada fallo se audita (`login_failure` en `audit_events`) para detectar campanas.

## 2. Robo de la base de datos

El atacante obtiene hashes, nunca secretos utiles:

| Dato | Proteccion | Donde |
|---|---|---|
| password | argon2id + sal unica | `users.password_hash` |
| refresh token | solo SHA-256 (inutil sin el original) | `refresh_tokens.token_hash` |
| recovery codes | SHA-256 + sal por codigo | `recovery_codes.(code_hash, salt)` |
| seed TOTP | en claro (DEUDA EXPLICITA) | `mfa_secrets.secret` |

Deuda: el seed TOTP esta aislado en su propia tabla para cifrarlo despues
(clave de entorno/KMS) sin tocar el service. Ver `arquitectura.txt` §9.

## 3. Robo de un refresh token

- Rotacion con `UPDATE ... RETURNING` atomico: el primero que rota gana.
- Reutilizacion vieja (>10s) = probable robo: se revoca la FAMILIA ENTERA
  y se audita `refresh_reuse_detected` (`src/modules/sessions/sessions.service.ts`).
- Reutilizacion reciente = carrera legitima: falla cerrado (401) SIN nukear.
- Ventana de abuso acotada al TTL del access (15 min).
- Activar MFA revoca las sesiones pre-existentes: los refresh emitidos antes
  del alta nunca rinden `mfa:true` (`MfaService.confirm` fuerza re-login).

## 4. Enumeracion de usuarios

Login y MFA devuelven el mismo 401 generico exista o no el email
(`AuthError`, mensaje fijo). Unico trade-off: el registro devuelve 409
(registrarse revela por naturaleza; documentado, no descuido).

## 5. Tokens forjados

JWT HS256 con secreto >=32 bytes validado al arranque (el proceso muere si
es debil). `mfa_ticket` con `scope: "mfa"` de 5 min que no autoriza nada mas.

## Reglas verificables por el jurado

1. Ningun secreto en git: `.env` ignorado, solo `.env.example` falso.
2. Ningun secreto en logs: `sanitize()` + lista de claves prohibidas
   (`src/shared/logger.ts`) + test de no-filtracion.
3. Ningun secreto en respuestas: tests de integracion lo comprueban
   (sin `password_hash`, refresh guardado hasheado, 500 sin stack).
4. Dependencias con lockfile (`package-lock.json` commiteado).

## Explícitamente fuera de alcance

- Phishing / malware en el dispositivo (mitigacion futura: WebAuthn).
- Seguridad de la infraestructura de la VM (fase 2: `k8s/`, proxy TLS).
- DoS volumetrico (el rate limiting es anti-abuso, no anti-DDoS).
