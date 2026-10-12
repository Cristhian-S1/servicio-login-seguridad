# Auto-actualización del servidor (polling)

La VM de Proxmox trae sola los cambios de `main`: un timer de systemd revisa la
rama cada 5 minutos y, si hay un commit nuevo con la compuerta de CI en verde,
corre `npm run deploy` (backup de la base + migraciones + reinicio + `/health`).

Complementa a [`actualizacion-servidor.md`](actualizacion-servidor.md) (el flujo
manual) y [`despliegue-vm.md`](despliegue-vm.md) (instalación inicial).

## Cómo funciona

El repo es **público** y la VM **no tiene entrada desde internet**: GitHub no
puede avisarle de un push (no hay webhook ni runner autoalojado). Por eso el
modelo es **polling**:

1. `servicio-login-update.timer` dispara el oneshot
   `servicio-login-update.service` cada 5 minutos (a los 2 minutos del arranque,
   con hasta 30 s de desfase aleatorio).
2. El servicio corre `scripts/auto-update.sh` como el usuario dueño del repo.
3. El script hace `git fetch origin main` y decide:

   | Situación | Qué hace |
   |---|---|
   | `HEAD` ya está al día | `sin cambios` y termina |
   | Sin red / GitHub caído | `sin red, se reintenta` y termina |
   | Cambios locales en archivos rastreados | Error (exit 1); no despliega |
   | `origin/main` no desciende de `HEAD` (no fast-forward) | Error (exit 1); no despliega |
   | El commit ya está anotado en `last-failed-sha` | Termina en silencio; no lo reintenta |
   | Checks de CI aún corriendo | `esperando CI`; reintenta en el próximo tick |
   | Algún check en rojo, o `verify` no está en `success` | No despliega; anota el commit como fallido (`neutral` y `skipped` de otros checks no cuentan como rojo) |
   | La API de GitHub no responde | No despliega (fail-closed); reintenta |
   | Commit sin firma válida (si exiges firmas) | Error; no despliega |
   | `AUTO_UPDATE_DRY_RUN=1` | Solo imprime `DRY-RUN: desplegaria <sha>` |
   | Todo en verde | `git merge --ff-only <sha verificado>` + `npm run deploy` (con `SKIP_GIT_PULL=1`) + `/health` |

> **Se despliega el commit verificado, no "lo último de main".** El script
> avanza al SHA exacto que pasó la compuerta y exporta `SKIP_GIT_PULL=1` para
> que `deploy.sh` no haga otro `git pull`: si `main` avanzara entre la
> comprobación y el deploy, ese commit posterior (sin verificar) no se
> desplegaría. `deploy.sh` usa además `npm ci`, que instala exactamente
> `package-lock.json` (el mismo que verifica el CI) y no ensucia el árbol.

4. Tras desplegar verifica `/health` (hasta 10 intentos cada 2 s) y guarda el
   resultado en `data/auto-update/status.json`. Si falla, anota el commit en
   `data/auto-update/last-failed-sha` y sale con error. **No hay rollback
   automático**: la base pudo migrar; los backups previos quedan en
   `data/backups` (ver [`proteccion-datos.md`](proteccion-datos.md)).

Todos los mensajes van a stdout con prefijo de fecha (los recoge el journal de
systemd). El script nunca imprime tokens ni el contenido de `.env`.

## La compuerta de CI (y sus límites)

`.github/workflows/ci.yml` define dos jobs en cada push a `main` y en cada PR:
`verify` (`npm ci` + `tsc --noEmit` + `npm test`) y `shell` (`bash -n` +
`shellcheck`). Antes de desplegar, el script consulta los *check runs* del
commit en la API de GitHub y exige:

- que exista al menos un check run y, en particular, uno llamado `verify`;
- que **todos** estén `completed` y con conclusión `success`.

**Límites:** el CI valida que el proyecto compile y que pasen los tests; **no
detecta código malicioso**. Un commit que pasa CI puede ejecutar cualquier cosa
al desplegarse (scripts de `npm`, build, migraciones). La compuerta protege
contra errores, no contra un atacante con permiso de escritura en `main`.

## Modelo de amenaza

**Quien pueda empujar a `main` ejecuta código en el servidor**: el timer
despliega automáticamente lo que llegue a `main` con CI verde, como el usuario
dueño del repo, y el deploy puede reiniciar `servicio-login` vía sudo. Para
reducir ese riesgo:

- Protege `main` en GitHub: **PR obligatorio**, check `verify` requerido,
  prohibido el push directo (incluye administradores) y **2FA** en todas las
  cuentas con permiso de escritura.
- Commits firmados (opcional): define `AUTO_UPDATE_ALLOWED_SIGNERS` apuntando a
  un archivo de *allowed signers* de SSH y el script exigirá
  `git verify-commit` válido antes de desplegar. Para firmar:

  ```bash
  git config --global gpg.format ssh
  git config --global user.signingkey ~/.ssh/id_ed25519
  git commit -S ...
  ```

- La VM no guarda credenciales de GitHub (el repo es público; la API de checks
  se consulta sin token) y no puede hacer push.
- El sudoers queda limitado a `restart` y `status` de `servicio-login`; el
  endurecimiento del sistema no corre desde aquí (ver más abajo).

## Instalación y desinstalación

Desde el repo, **como root** pero invocado con sudo (el servicio corre como el
usuario que invoca, detectado vía `SUDO_USER`):

```bash
sudo bash scripts/install-auto-update.sh
```

Instala/actualiza las units `/etc/systemd/system/servicio-login-update.service`
y `.timer`, escribe la regla `/etc/sudoers.d/servicio-login-update` (validada
con `visudo -cf` **antes** de instalarse; si no valida, no instala nada),
recarga systemd y activa el timer. Es idempotente y no toca firewall, SSH ni el
servicio principal.

```bash
sudo bash scripts/install-auto-update.sh --uninstall
```

Desinstala: detiene y deshabilita el timer, elimina las units y la regla
sudoers y recarga systemd.

## Configuración

Todas las variables tienen default y pueden definirse en
`/etc/servicio-login/auto-update.env` (opcional, no versionado), que el script
carga si existe:

| Variable | Default | Para qué |
|---|---|---|
| `AUTO_UPDATE_BRANCH` | `main` | Rama a seguir |
| `AUTO_UPDATE_REQUIRE_CI` | `1` | `0` desactiva la compuerta de CI (no recomendado) |
| `AUTO_UPDATE_DRY_RUN` | `0` | `1` = solo informa qué desplegaría, sin tocar nada |
| `AUTO_UPDATE_HARDENING` | `0` | `1` deja que el deploy ejecute `harden-server.sh` (normalmente **no**: esa parte es manual) |
| `AUTO_UPDATE_ALLOWED_SIGNERS` | (vacío) | Archivo de allowed signers; si está definido, exige firma válida |
| `AUTO_UPDATE_STATE_DIR` | `<repo>/data/auto-update` | Lock, `status.json`, `last-failed-sha` |
| `AUTO_UPDATE_HEALTH_URL` | `http://127.0.0.1:3000/health` | Verificación posterior al deploy |
| `PORT` | `3000` | Solo se usa si no defines `HEALTH_URL` |

Ejemplo de `/etc/servicio-login/auto-update.env`:

```bash
AUTO_UPDATE_REQUIRE_CI=1
AUTO_UPDATE_ALLOWED_SIGNERS=/etc/servicio-login/allowed-signers
```

## Cómo ver el estado

```bash
systemctl list-timers servicio-login-update.timer     # próxima ejecución
systemctl status servicio-login-update.service        # último resultado
journalctl -u servicio-login-update -e --no-pager     # historial completo
cat <repo>/data/auto-update/status.json               # {sha, at, result}
cat <repo>/data/auto-update/last-failed-sha           # si existe: ese commit falló
```

Para forzar una ejecución ahora: `sudo systemctl start servicio-login-update.service`
(o `cd <repo> && bash scripts/auto-update.sh` como el usuario del repo; el lock
evita que se pise con el timer). Para una simulación:
`cd <repo> && AUTO_UPDATE_DRY_RUN=1 bash scripts/auto-update.sh`.

## Qué hacer si un commit falla

- **CI en rojo**: el commit queda en `last-failed-sha` y no se reintenta. Arregla
  con un PR nuevo (commit nuevo = reintento automático). Si vuelves a correr los
  jobs en GitHub y pasan, borra `data/auto-update/last-failed-sha` para que el
  próximo tick lo despliegue. Si un check queda pendiente para siempre, revisa
  el workflow.
- **Deploy fallido** (build, migración, permisos): mira
  `journalctl -u servicio-login-update -e`. El commit queda marcado como fallido;
  corrige con un commit nuevo. La base pudo migrar: los backups están en
  `data/backups` (ver [`proteccion-datos.md`](proteccion-datos.md)).
- **`/health` no responde**: el código nuevo quedó desplegado igual (no hay
  rollback automático). Revisa `journalctl -u servicio-login -e`; para volver
  atrás, sube un commit de revert (no hagas `reset` local: el script exige
  árbol limpio y fast-forward).
- **Pausar**: `sudo systemctl disable --now servicio-login-update.timer`;
  reactivar con `sudo systemctl enable --now servicio-login-update.timer`.

## Límite de la API de GitHub

Sin token, la API permite **60 consultas por hora por IP**. El script solo
consulta cuando hay un sha nuevo (los ticks sin cambios terminan antes), así
que en el uso normal sobra margen. Si se agota, la compuerta queda fail-closed
y reintenta en el próximo tick. No hace falta token: el repo es público.

## El endurecimiento queda manual

`scripts/harden-server.sh` (firewall, SSH, fail2ban, sysctl, aislamiento) **no
corre en la auto-actualización**: por defecto el deploy se lanza con
`SKIP_HARDENING=1`. El motivo es que esos cambios pueden cortar el acceso
remoto y se hacen a mano, con una segunda sesión SSH abierta y un snapshot de
Proxmox (pasos y rollback en
[`actualizacion-servidor.md`](actualizacion-servidor.md)).

Para aplicar el endurecimiento:

```bash
cd <repo>
git pull --ff-only
npm run deploy        # sin SKIP_HARDENING: reintenta el endurecimiento (idempotente)
```

`AUTO_UPDATE_HARDENING=1` existe para casos puntuales, pero el usuario del
servicio necesitaría sudo para `harden-server.sh`, algo que la regla sudoers
instalada **no** permite a propósito.

## Referencias

- [`actualizacion-servidor.md`](actualizacion-servidor.md): actualización manual,
  endurecimiento y rollback.
- [`despliegue-vm.md`](despliegue-vm.md): instalación inicial de la VM.
- [`proteccion-datos.md`](proteccion-datos.md): backups y restauración.
