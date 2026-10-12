# Actualizar el servidor (VM en Proxmox)

Guía para aplicar en el servidor los cambios que se suben a `main`. Aplica a una
VM **ya desplegada** con `npm run vm:setup` (servicio systemd
`servicio-login`, `.env` existente, base en `data/`).

## Resumen: el flujo de siempre

```bash
cd <ruta-del-repo>        # ver "Encontrar la ruta del repo"
git pull
npm run deploy
```

Esas tres líneas hacen todo: traen el código, reinstalan dependencias,
recompilan, **respaldan la base**, migran, **aplican el endurecimiento** y
reinician el servicio. Termina consultando `/health`.

> **Por qué `git pull` a mano y no solo `npm run deploy`.** `deploy.sh` también
> hace `git pull`, pero un script de bash que se reescribe mientras corre puede
> comportarse mal. Con el `git pull` previo, `npm run deploy` ya ejecuta la
> versión nueva del script y su propio pull no hace nada.

## Encontrar la ruta del repo

La documentación original usa `~/servicio-login-seguridad-main`. Para no
adivinar, pregúntale a systemd dónde corre el servicio:

```bash
systemctl show servicio-login -p WorkingDirectory --value
```

## Antes de la primera actualización con endurecimiento

Este cambio toca el firewall y SSH. Si algo sale mal puedes quedarte sin acceso
remoto, así que prepara la red de seguridad **antes**:

1. **Snapshot en Proxmox** de la VM (Datacenter → VM → Snapshots → Take
   Snapshot). Es el rollback más rápido y completo.
2. **Segunda sesión SSH abierta** y sin cerrar durante todo el proceso.
3. **Consola de Proxmox** (noVNC) a mano: entra por ahí aunque UFW o SSH te
   dejen fuera.
4. Tu usuario debe poder usar `sudo` (te pedirá la contraseña una vez).

Qué cambia en esa primera ejecución:

| Área | Cambio |
|---|---|
| Datos | Backup de `data/login.db` en `data/backups/` antes de migrar |
| Firewall | UFW: entrada denegada salvo SSH y el puerto de la app (`3000`) |
| SSH | `PermitRootLogin no`, `MaxAuthTries 3`, `X11Forwarding no`, keepalive |
| Fuerza bruta | fail2ban con jail `sshd` (5 intentos, ban de 1 h) |
| Kernel | Parámetros `sysctl` de red y protección de enlaces |
| Parches | Actualizaciones de seguridad automáticas (`unattended-upgrades`) |
| Servicio | Aislamiento systemd: `NoNewPrivileges`, `ProtectSystem=strict`… |

La autenticación por contraseña de SSH **no se desactiva** por defecto (ver
"Desactivar la contraseña de SSH").

## Primera actualización

```bash
cd <ruta-del-repo>
git pull
npm run deploy
```

Si `git pull` se queja de cambios locales, no los descartes a ciegas: revisa
con `git status` y `git diff` qué tocó alguien en el servidor.

Luego verifica:

```bash
curl -fsS http://127.0.0.1:3000/health        # la app responde
sudo ufw status verbose                        # firewall activo, SSH y 3000 permitidos
sudo fail2ban-client status sshd               # jail activa
sudo sshd -T | grep -E 'permitrootlogin|maxauthtries|x11forwarding|passwordauthentication'
systemctl show servicio-login -p NoNewPrivileges -p ProtectSystem -p ReadWritePaths
ls -la data/backups                            # al menos una copia, permisos 600
journalctl -u servicio-login -e --no-pager     # sin errores de arranque
```

Prueba también abrir **una sesión SSH nueva** desde tu equipo antes de cerrar
la que tienes abierta.

## Actualizaciones normales

```bash
cd <ruta-del-repo>
git pull
npm run deploy
```

El endurecimiento es idempotente: solo reescribe lo que cambió y no rompe nada
si ya estaba aplicado. Cada deploy genera un backup nuevo y conserva los 14
más recientes.

Variaciones útiles:

```bash
SKIP_HARDENING=1 npm run deploy      # despliega sin tocar firewall/SSH/sysctl
BACKUP_KEEP=30 npm run deploy        # conserva 30 backups en vez de 14
```

Variables opcionales (todas con valor por defecto): `BACKUP_DIR`
(`<dir de la base>/backups`), `BACKUP_KEEP` (`14`), `PORT` (`3000`),
`DB_PATH` (`./data/login.db`).

## Desactivar la contraseña de SSH (opcional, recomendado)

Está desactivado por defecto porque, si la clave no funciona, nada te deja
volver a entrar. Hazlo en este orden:

1. Desde **tu equipo**, copia tu clave pública al servidor:
   ```bash
   ssh-copy-id <usuario>@<ip-del-servidor>
   ```
2. Comprueba que entras **solo con la clave** (esto falla si no funciona):
   ```bash
   ssh -o PasswordAuthentication=no <usuario>@<ip-del-servidor>
   ```
3. Solo entonces, en el servidor:
   ```bash
   cd <ruta-del-repo>
   HARDEN_SSH_DISABLE_PASSWORD=1 npm run deploy
   ```

Para revertirlo, ejecuta `npm run deploy` **sin** la variable: el script
reescribe el drop-in y la contraseña vuelve a estar permitida.

## Backups y restauración

Los backups quedan en `<repo>/data/backups/login-AAAAMMDD-HHMMSS.db`
(permisos `600`, verificados con `integrity_check`). Manual:

```bash
npm run db:backup
```

**Cópialos fuera de la VM**: un backup en el mismo disco no sirve si la VM
muere. Por ejemplo, desde tu equipo:

```bash
scp <usuario>@<ip-del-servidor>:<ruta-del-repo>/data/backups/login-*.db ./backups/
```

Restaurar (detalle en [`proteccion-datos.md`](proteccion-datos.md)):

```bash
sudo systemctl stop servicio-login
cp data/backups/login-AAAAMMDD-HHMMSS.db data/login.db
rm -f data/login.db-wal data/login.db-shm
chmod 600 data/login.db
sudo systemctl start servicio-login
```

## Si algo falla

| Síntoma | Qué hacer |
|---|---|
| El deploy se detiene en "backup de la base" | El backup falló y por diseño no migra. Revisa el error; la app sigue con la versión anterior. |
| `sudo -E` rechazado | Tu usuario no tiene `SETENV` en sudoers. Corre el endurecimiento a mano: `sudo bash scripts/harden-server.sh`. |
| El servicio no arranca tras el deploy | `journalctl -u servicio-login -e`. Sospecha del aislamiento: revisa que `ReadWritePaths` apunte al directorio de la base. |
| No entras por SSH | Usa la consola de Proxmox (noVNC) o tu segunda sesión y mira "Deshacer". |
| `git pull` pide credenciales | El servidor necesita acceso de lectura al repo (deploy key SSH o token HTTPS). |

## Deshacer el endurecimiento

Lo más seguro es **restaurar el snapshot de Proxmox**. Manualmente, por pieza:

```bash
# SSH
sudo rm -f /etc/ssh/sshd_config.d/00-hardening.conf
sudo sshd -t && sudo systemctl reload ssh

# Firewall (desactiva UFW por completo)
sudo ufw disable

# fail2ban
sudo rm -f /etc/fail2ban/jail.d/hardening.local
sudo systemctl restart fail2ban

# Aislamiento del servicio
sudo rm -rf /etc/systemd/system/servicio-login.service.d
sudo systemctl daemon-reload && sudo systemctl restart servicio-login

# sysctl: borrar el archivo; los valores vuelven a su default tras reiniciar
sudo rm -f /etc/sysctl.d/99-hardening.conf
```

Mientras tanto, `SKIP_HARDENING=1 npm run deploy` despliega código nuevo sin
volver a aplicar nada de lo anterior.

## Referencias

- [`despliegue-vm.md`](despliegue-vm.md): instalación inicial y detalle del
  endurecimiento (sección 11).
- [`proteccion-datos.md`](proteccion-datos.md): backups y restauración.
- [`runbook.md`](runbook.md): operación.
