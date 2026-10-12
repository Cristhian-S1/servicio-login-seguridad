# Telemetria del servidor

La telemetria es un resumen **agregado** del estado del servidor que se
publica periodicamente en un **repositorio privado separado** (nunca en este
repo) para poder verlo desde fuera. La componen:

| Pieza | Que hace |
|---|---|
| `scripts/collect-metrics.sh` | Imprime **un** objeto JSON con las metricas (best-effort). |
| `scripts/publish-telemetry.sh` | Recolecta, guarda copia local y publica en el repo privado. |
| `scripts/install-telemetry.sh` | Instala las unidades systemd (y desinstala con `--uninstall`). |
| `deploy/systemd/servicio-login-telemetry.service.in` | Plantilla del servicio (oneshot, con sandbox). |
| `deploy/systemd/servicio-login-telemetry.timer.in` | Plantilla del timer (cada 15 min). |
| `deploy/telemetry.env.example` | Plantilla de `/etc/servicio-login/telemetry.env`. |

El timer `servicio-login-telemetry.timer` ejecuta la publicacion cada 15
minutos (y 3 minutos despues de cada arranque). El servicio corre como `root`
(necesita leer el journal, UFW, fail2ban, apt) pero con sandbox de systemd:
`ProtectSystem=strict`, `ProtectHome=read-only`, `NoNewPrivileges=yes`, y solo
puede escribir en `/var/lib/servicio-login`.

### Root no ejecuta codigo del repo

El repo lo escribe el usuario de la app (el mismo que ejecuta el servicio web,
expuesto a la red) y, si usas la auto-actualizacion, tambien recibe codigo
nuevo de `main`. Si root ejecutara `scripts/*.sh` directamente desde ahi,
cualquier ejecucion de codigo en la app —o un push malicioso— se convertiria en
root en como mucho 15 minutos. Por eso:

- `install-telemetry.sh` copia `collect-metrics.sh` y `publish-telemetry.sh` a
  `/usr/local/lib/servicio-login-telemetry/` (propiedad de root, `0755`) y la
  unidad systemd ejecuta **esas copias**.
- El repo se pasa solo como `TELEMETRY_APP_DIR`, para **leer** datos de el
  (tamano de la base, backups, `status.json`, `.git/HEAD`).
- Root no invoca `git` sobre el repo del usuario (su `.git/config` lo controla
  otro usuario): el commit desplegado se lee de `.git/HEAD` y el `origin` con
  `git config --file`.
- La copia local de la muestra se escribe en `/var/lib/servicio-login/local`,
  nunca en el `data/` del usuario (un symlink plantado ahi haria que root
  sobrescribiera un archivo ajeno).

**Consecuencia:** si cambias estos scripts en el repo, vuelve a ejecutar
`sudo bash scripts/install-telemetry.sh` para refrescar las copias de root.
Revisa los scripts antes de instalarlos: el instalador copia lo que haya en el
repo en ese momento.

## Por que un repositorio privado separado (y nunca el de la app)

Dos razones, ambas obligatorias:

1. **El repo de la app es publico.** Publicar la telemetria ahi expondria la
   infraestructura: cuando falla el servicio, parches de seguridad pendientes,
   intentos de intrusion, actividad del servidor. Es informacion util para un
   atacante y para cualquiera que raspe GitHub.
2. **Darle al servidor escritura sobre el repo que se auto-despliega seria una
   via de inyeccion de codigo.** `deploy.sh` hace `git pull` de este repo; si
   el servidor (o su deploy key) pudiera empujar commits aqui, comprometer la
   VM permitiria publicar codigo que la propia maquina ejecutaria al siguiente
   deploy. El repo de telemetria no se despliega ni se ejecuta: en el peor caso
   contiene un `STATUS.md` y unos JSON.

Por eso la deploy key de telemetria es **dedicada y con escritura solo en el
repo de telemetria**: si se filtra, no da acceso al repo de la aplicacion.

## Que se recolecta

`collect-metrics.sh` emite **un objeto JSON por linea**. Todos los campos son
best-effort: lo que no se puede obtener queda en `null` y la recoleccion nunca
aborta.

| Campo | Que es | Fuente |
|---|---|---|
| `ts` | Marca de tiempo en UTC (ISO 8601) | reloj del sistema |
| `uptime_s` | Segundos desde el arranque | `/proc/uptime` |
| `load1`, `load5`, `load15` | Carga media | `/proc/loadavg` |
| `mem_used_pct` | % de memoria en uso | `/proc/meminfo` |
| `disk_used_pct` | % de disco del filesystem de `data/` | `df` |
| `service_active` | `true`/`false`: servicio `servicio-login` activo | `systemctl` |
| `service_restarts` | Reinicios acumulados (`NRestarts`) | `systemctl` |
| `health_http_code`, `health_ms` | Codigo HTTP y latencia de `GET /health` | HTTP local |
| `db_size_bytes` | Tamano de la base SQLite en bytes | archivo |
| `backups_count`, `backup_newest_age_s` | Copias y antiguedad de la mas nueva | `data/backups` |
| `deployed_sha` | Commit desplegado (7 caracteres) | `.git/HEAD` (leido a mano) |
| `last_update` | `sha`/`at`/`result` del auto-update | `data/auto-update/status.json` |
| `ufw_active` | `true`/`false`: firewall UFW activo | `ufw` |
| `fail2ban_banned` | **Numero** de direcciones baneadas (todos los jails) | `fail2ban-client` |
| `ssh_failed_1h` | **Numero** de intentos SSH fallidos de la ultima hora | `journalctl` de ssh/sshd |
| `app_log_counts_1h` | `{info, warn, error}` de la app (ultima hora) | `journalctl` de servicio-login |
| `security_updates_pending` | Paquetes con actualizacion de seguridad pendiente | `apt` |
| `reboot_required` | `true`/`false`: hace falta reiniciar | `/var/run/reboot-required` |

## Lo que NO se recolecta nunca

- **IPs**: ni del servidor, ni de clientes, ni de atacantes.
- **Nombres de usuario, emails o cualquier identificador personal.**
- **Lineas crudas de log o mensajes**: de SSH solo se guarda un contador; de
  la app solo conteos por nivel (`info`/`warn`/`error`).
- **Contenido del `.env`** ni secretos (JWT, contraseñas, claves).
- **Contenido de la base de datos**: solo su tamano en bytes.
- Configuracion de firewall/SSH: solo el booleano de UFW y el numero de baneos.

Puedes comprobarlo tu mismo en el servidor:

```bash
bash scripts/collect-metrics.sh
```

## Instalacion paso a paso

1. **Instala el ciclo** (root, idempotente):

   ```bash
   sudo bash scripts/install-telemetry.sh
   ```

   Crea `/var/lib/servicio-login` (0700), `/etc/servicio-login/telemetry.env`
   (0600, solo si no existia), instala las copias propiedad de root en
   `/usr/local/lib/servicio-login-telemetry`, las unidades systemd y habilita
   el timer. Vuelve a ejecutarlo tras actualizar los scripts de telemetria.

2. **Crea el repositorio privado** en GitHub, por ejemplo
   `<tu-usuario>/servicio-login-telemetria`. No lo hagas publico: la guarda de
   `publish-telemetry.sh` se negaria a publicar (consulta la API de GitHub sin
   token y un HTTP 200 significa publico).

3. **Genera la deploy key dedicada** (no la compartas con nada mas):

   ```bash
   sudo ssh-keygen -t ed25519 -f /etc/servicio-login/telemetry_key -N ""
   ```

4. **Agrega la clave publica como deploy key** en el repo de telemetria:
   GitHub → repo → Settings → Deploy keys → Add deploy key → pega el contenido
   de `/etc/servicio-login/telemetry_key.pub` y marca **"Allow write access"**.
   Solo en ESE repo.

5. **Configura `TELEMETRY_REPO`** en `/etc/servicio-login/telemetry.env`:

   ```bash
   sudo nano /etc/servicio-login/telemetry.env
   # TELEMETRY_REPO=git@github.com:<tu-usuario>/servicio-login-telemetria.git
   ```

   El resto de variables ya coincide con los valores por defecto del
   instalador. Variables disponibles:

   | Variable | Default | Que es |
   |---|---|---|
   | `TELEMETRY_REPO` | (vacio) | URL del repo privado de telemetria. Vacio = solo local. |
   | `TELEMETRY_SSH_KEY` | (vacio) | Deploy key dedicada (`/etc/servicio-login/telemetry_key`). |
   | `TELEMETRY_BRANCH` | `main` | Rama a publicar. |
   | `TELEMETRY_DIR` | `/var/lib/servicio-login/telemetry` | Clon local del repo. |
   | `TELEMETRY_ALLOW_PUBLIC` | `0` | `1` permite publicar en un repo publico (no recomendado). |

   Prioridad: variables de entorno > `telemetry.env` > defaults. Si la app usa
   otro `DB_PATH`, `BACKUP_DIR` o `PORT`, definelos tambien en `telemetry.env`:
   se exportan al recolector.

6. **Lanza el primer ciclo y comprueba**:

   ```bash
   sudo systemctl start servicio-login-telemetry.service
   journalctl -u servicio-login-telemetry.service -e --no-pager
   systemctl list-timers servicio-login-telemetry.timer
   ```

7. **Abre `STATUS.md`** en el repo privado de GitHub.

## Como verlo

- **`STATUS.md`** (raiz del repo privado): tabla legible con los valores
  actuales y un resumen de las ultimas 24 h (muestras, load1 min/max, errores
  de app e intentos SSH fallidos). Es la vista recomendada.
- **`data/telemetry/latest.json`**: ultima muestra en JSON crudo. Tambien
  queda una copia local en el servidor: `/var/lib/servicio-login/local/latest.json`
  cuando corre el timer (root) o `<repo de la app>/data/telemetry/latest.json`
  si ejecutas el script a mano como tu usuario (ignorada por git).
- **`data/telemetry/history/YYYY-MM-DD.jsonl`**: una linea por muestra. Los
  archivos con mas de 30 dias se borran automaticamente.
- En el propio servidor: `sudo cat /var/lib/servicio-login/local/latest.json`.

## Guardas de seguridad de `publish-telemetry.sh`

Antes de publicar, y en este orden:

1. **Se niega a publicar en el repo de la app** (exit 1): compara
   `TELEMETRY_REPO` con el `origin` de la app (leido con
   `git config --file .git/config`), normalizando `git@github.com:...` y
   `https://github.com/...` y **sin distinguir mayusculas** (GitHub tampoco).
2. **Se niega a publicar en un repo publico de GitHub** (exit 1): consulta
   `https://api.github.com/repos/<owner>/<repo>` **sin token**; HTTP 200 =
   publico. HTTP 404 = privado o inexistente, continua. Si la consulta falla
   (sin red, limite de peticiones), **no publica** (fail-closed). Esto incluye
   repos cuyo owner y nombre coinciden (`usuario/usuario`). Con
   `TELEMETRY_ALLOW_PUBLIC=1` se salta la comprobacion a proposito.
3. **Se niega a publicar en remotos que no son GitHub ni una ruta local**
   (exit 1): desde aqui no se puede comprobar su visibilidad. Si es un repo
   privado de otro proveedor, `TELEMETRY_ALLOW_PUBLIC=1` lo permite sabiendo que
   no se verifica.
4. **Un fallo de red es exit 0**: se registra y se reintenta en el siguiente
   ciclo del timer.
5. El commit usa autor fijo `servicio-login-telemetry <telemetry@localhost>`.
6. El `push` usa una `GIT_SSH_COMMAND` con la deploy key, `IdentitiesOnly=yes`
   y un `known_hosts` propio (`/var/lib/servicio-login/known_hosts`).
7. Todas las operaciones git usan `core.hooksPath=/dev/null`, para no ejecutar
   hooks de un repo que no controlamos.

## Rotacion y revocacion de la deploy key

Rotacion (rutina, sin cortar el servicio):

1. Genera una clave nueva sin pisar la actual:
   `sudo ssh-keygen -t ed25519 -f /etc/servicio-login/telemetry_key.new -N ""`
2. Agrega `telemetry_key.new.pub` como deploy key (con escritura) en el repo
   de telemetria.
3. Apunta `TELEMETRY_SSH_KEY` a la clave nueva (o espera al siguiente ciclo y
   comprueba que publica) y verifica un ciclo exitoso.
4. Reemplaza el archivo y borra la clave vieja:
   `sudo mv /etc/servicio-login/telemetry_key.new /etc/servicio-login/telemetry_key`
   y elimina la deploy key vieja en GitHub. `chmod 600` a la clave nueva.
5. Borra `telemetry_key.new.pub` si ya no lo necesitas.

Revocacion (clave comprometida): elimina la deploy key en GitHub **primero**
(eso revoca el acceso al instante), genera una nueva, y revisa el historial de
commits del repo de telemetria por si hubo escrituras inesperadas. Recuerda que
esa clave solo tenia escritura en el repo de telemetria, no en el de la app.

El `known_hosts` propio vive en `/var/lib/servicio-login/known_hosts`. La
primera conexion acepta la clave del host (`StrictHostKeyChecking=accept-new`).

## Desinstalacion

```bash
sudo bash scripts/install-telemetry.sh --uninstall
```

Detiene y deshabilita el timer y elimina las unidades systemd. **No borra** la
configuracion ni el estado; para limpiar del todo:

```bash
sudo rm -rf /etc/servicio-login /var/lib/servicio-login
```

Y revoca la deploy key en GitHub (Settings → Deploy keys).

## Solucion de problemas

| Sintoma | Causa y que hacer |
|---|---|
| `telemetria remota no configurada (solo local)` | `TELEMETRY_REPO` vacio: configura el repo privado. |
| `TELEMETRY_REPO apunta al MISMO repositorio que la app` | La guarda hizo su trabajo: usa un repo privado separado, nunca el de la app. |
| `TELEMETRY_REPO es un repositorio PUBLICO` | Hazlo privado o, si de verdad lo quieres, `TELEMETRY_ALLOW_PUBLIC=1`. |
| `no se pudo verificar la visibilidad ... (fail-closed)` | Sin acceso a la API de GitHub (red o limite); no publica y se reintenta. |
| `no puedo verificar la visibilidad ... (no es GitHub ni una ruta local)` | Remoto de otro proveedor: usa GitHub o define `TELEMETRY_ALLOW_PUBLIC=1` sabiendo que no se comprueba. |
| `fallo de red al contactar/clonar/publicar` | Normal sin conectividad; el timer lo reintenta en 15 min. |
| `la copia local de telemetria diverge` | Alguien escribio en `TELEMETRY_DIR`; borralo y espera el siguiente ciclo. |
| No hay `STATUS.md` ni commits nuevos | `journalctl -u servicio-login-telemetry.service -e` y revisa `telemetry.env`. |
