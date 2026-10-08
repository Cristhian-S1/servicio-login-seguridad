# Despliegue en la VM (Kubuntu) - servicio-login

Recorrido completo desde el clonado del repositorio hasta dejar el servicio
persistente con systemd. Entorno usado: VM Kubuntu en Proxmox, IP de la VM
`146.83.102.66/25`, API escuchando en el puerto `3000`.

## 0. Automatización (recomendado)

Los pasos de este documento están empaquetados en scripts idempotentes:

```bash
# Provisiona todo: .env + secreto, dependencias, build, migraciones,
# systemd, firewall y (si se pide) la IP secundaria persistente.
npm run vm:setup
IP_CIDR=192.168.102.91/24 IFACE=ens18 npm run vm:setup   # con IP extra
SEED_PASSWORD='Demo!Passw0rd123' npm run vm:setup        # con seed

# Para actualizar tras un pull: pull + install + build + migraciones + restart
npm run deploy

# Solo la IP secundaria (el paso pendiente de la seccion 9)
IP_CIDR=192.168.102.91/24 IFACE=ens18 npm run ip:persist
```

`npm run vm:setup` usa `sudo` internamente para systemd, ufw y la IP, así que
conviene ejecutarlo como tu usuario normal (no como root). Las secciones
siguientes documentan lo que hacen los scripts, por si hay que hacerlo a mano.

## 1. Clonar e instalar dependencias

```bash
git clone <URL_DEL_REPO> servicio-login-seguridad-main
cd servicio-login-seguridad-main
node -v          # se requiere Node >= 20.6
npm install
```

## 2. Configurar el entorno

```bash
cp .env.example .env
openssl rand -hex 32
nano .env
```

Contenido esperado de `.env`:

```dotenv
JWT_SECRET=<el_hex_generado_de_64_caracteres>
PORT=3000
```

`JWT_SECRET` debe tener 32 caracteres o más y no puede ser el valor de ejemplo
de `.env.example`, o el arranque falla con `Invalid environment`.

## 3. Cargar las variables en el shell (gotcha importante)

Este proyecto **no usa `dotenv` ni `--env-file`**: el archivo `.env` no se carga
solo, aunque el README diga lo contrario. Hay que exportarlo en cada shell:

```bash
set -a
. ./.env
set +a
```

Alternativa para producción, sin depender del shell:

```bash
node --env-file=.env dist/src/server.js
```

## 4. Aplicar migraciones y seed opcional

```bash
npm run db:migrate
SEED_PASSWORD='Demo!Passw0rd123' npm run db:seed   # opcional, crea demo@example.com
```

La base queda en `./data/login.db` (default de `DB_PATH`, ignorada por git).

## 5. Arranque en desarrollo

```bash
npm run dev
curl http://localhost:3000/health
# -> {"status":"ok"}
```

## 6. Verificar red y firewall

```bash
ss -tlnp | grep 3000        # debe mostrar *:3000 (todas las interfaces)
sudo ufw status
sudo ufw allow 3000/tcp     # solo si ufw está activo
ip -br a                    # confirmar la IP real de la VM
```

Prueba desde otro equipo de la red:

```bash
curl http://146.83.102.66:3000/health
```

## 7. Build de producción y persistencia con systemd

Primero compilar (el build copia migraciones y el frontend dentro de `dist/`):

```bash
cd ~/servicio-login-seguridad-main
npm run build
which node                  # anotar la ruta para el unit de systemd
```

Detener cualquier proceso manual para liberar el puerto:

```bash
pkill -f "dist/src/server.js"; pkill -f "tsx src/server.ts"
```

Crear el servicio (ajustar usuario/ruta si cambian):

```bash
sudo tee /etc/systemd/system/servicio-login.service >/dev/null <<'EOF'
[Unit]
Description=servicio-login API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kiguel
WorkingDirectory=/home/kiguel/servicio-login-seguridad-main
EnvironmentFile=/home/kiguel/servicio-login-seguridad-main/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

Activar y arrancar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now servicio-login
systemctl status servicio-login --no-pager
```

Verificar que sobrevive un reinicio:

```bash
sudo reboot
# al volver:
systemctl is-enabled servicio-login
systemctl is-active servicio-login
curl http://146.83.102.66:3000/health
```

## 8. Frontend de verificación

Al abrir `http://146.83.102.66:3000/` se sirve un panel estático
(`public/index.html`) que comprueba `/health` y permite disparar registro y
login sin salir del navegador. En `/docs` sigue Swagger.

No hay paso de build de frontend ni dependencias nuevas. Para publicar cambios
del frontend en la VM:

```bash
npm run build
sudo systemctl restart servicio-login
```

Nota: `express.static` resuelve `public/` relativo al archivo compilado, por eso
el build lo copia a `dist/public/`. Si se corre `tsc` suelto, el frontend no
queda en `dist/`.

## 9. PENDIENTE: persistir la IP 192.168.102.91

Automatizado con `npm run ip:persist`:

```bash
IP_CIDR=192.168.102.91/24 IFACE=ens18 npm run ip:persist
```

El script agrega la IP en caliente si falta y la persiste según el gestor de red
activo: NetworkManager (`nmcli connection modify ... +ipv4.addresses`) o netplan
(te deja el YAML exacto si no puede automatizarlo). Es idempotente.

Estado actual: la IP se agregó de forma **temporal**, no sobrevive reinicios:

```bash
sudo ip addr add 192.168.102.91/24 dev ens18
```

El servicio ya escucha en todas las interfaces, así que en cuanto la IP exista
en la VM responde ahí sin tocar código. Falta dejarla persistente. Diagnóstico
previo:

```bash
systemctl is-active NetworkManager systemd-networkd
nmcli -t -f NAME,DEVICE,TYPE connection show
cat /etc/netplan/*.yaml 2>/dev/null
```

Opción A, NetworkManager (probable en Kubuntu):

```bash
sudo nmcli connection modify "<NOMBRE_CONEXION>" +ipv4.addresses 192.168.102.91/24
sudo nmcli connection up "<NOMBRE_CONEXION>"
ip -br a
```

Opción B, netplan, agregando la IP a la interfaz en `/etc/netplan/*.yaml`:

```yaml
network:
  version: 2
  ethernets:
    ens18:
      dhcp4: true
      addresses: [192.168.102.91/24]
```

```bash
sudo netplan apply
```

Si la red `192.168.102.0/24` vive en otra bridge de Proxmox, no basta con la IP:
hay que agregar un segundo NIC a la VM en esa bridge y configurarlo. Verificar
siempre tras un reinicio con `ip -br a` y `curl http://192.168.102.91:3000/health`.

## 10. Operación básica

- Logs del servicio: `journalctl -u servicio-login -e`
- Backup de la base: copiar `data/login.db` con el servicio detenido.
- Rotar `JWT_SECRET`: editar `.env`, `sudo systemctl restart servicio-login`.
  Los tokens viejos mueren en un máximo de `ACCESS_TTL_MINUTES`.
- `.env` nunca se commitea ni se copia a la imagen.
