# Proteccion de datos (SQLite) - servicio-login

Respaldo de la base `login.db`: que protege, como usarlo y como restaurar.

## Que protege el backup

`npm run db:backup` genera una copia consistente de la base con la API de
backup en linea de better-sqlite3 (`db.backup()`, la misma de SQLite). No se
copia el archivo a mano: la copia se hace "en caliente" y sigue sirviendo con
el servicio corriendo, incluyendo lo que todavia no se ha sincronizado del WAL
al archivo principal.

Cada copia:

- se guarda como `login-YYYYMMDD-HHMMSS.db` en el directorio de backups;
- se verifica abriendola y corriendo `PRAGMA integrity_check`; si no devuelve
  `ok`, la copia se borra y el script termina con error;
- queda con permisos `0600` (solo el dueno la lee) y el directorio con `0700`;
  tambien se aplica `0600` a la base y a sus sidecars `-wal`/`-shm`;
- se poda: se conservan solo las copias `login-*.db` mas recientes.

Protege frente a borrado o corrupcion de la base y permite volver a un estado
anterior. **No** reemplaza una copia fuera del servidor: si se pierde la VM
(disco, ransomware, borrado completo), una copia local se pierde con ella.

## Variables

| Variable | Default | Descripcion |
| --- | --- | --- |
| `DB_PATH` | `./data/login.db` | Base a respaldar. |
| `BACKUP_DIR` | `<directorio de la base>/backups` | Donde se guardan las copias. |
| `BACKUP_KEEP` | `14` | Cuantas copias recientes se conservan. |

Recordatorio: este proyecto **no** carga `.env` solo. Exporta las variables
antes de ejecutar:

```bash
set -a; . ./.env; set +a
npm run db:backup

# o con valores explicitos:
DB_PATH=./data/login.db BACKUP_DIR=./data/backups BACKUP_KEEP=7 npm run db:backup
```

Sugerencia de cron diario (03:00):

```cron
0 3 * * * cd /home/kiguel/servicio-login-seguridad-main && set -a && . ./.env && set +a && npm run db:backup
```

## Como restaurar

1. Detener el servicio: `sudo systemctl stop servicio-login`.
2. Copiar la copia elegida sobre la base:
   `cp data/backups/login-20261012-030000.db data/login.db`.
3. Borrar los archivos del WAL viejo (la base restaurada no debe arrastrarlos):
   `rm -f data/login.db-wal data/login.db-shm`.
4. Asegurar permisos: `chmod 600 data/login.db`.
5. Arrancar y verificar: `sudo systemctl start servicio-login` y
   `curl http://localhost:3000/health`.

Antes de restaurar conviene validar la copia:

```bash
sqlite3 data/backups/login-20261012-030000.db "PRAGMA integrity_check;"
# -> ok
```

## Recomendaciones

- Copiar los backups fuera del servidor (por ejemplo `scp`/`rsync` a otra
  maquina o almacenamiento cifrado); una copia solo local no sobrevive al
  borrado del servidor ni a un ransomware.
- Proteger el destino externo igual que `.env`: permisos `0600` y cifrado en
  reposo si el destino no es de confianza.
- Probar la restauracion cada cierto tiempo: una copia que nunca se prueba no
  es una copia.
