# Monitoreo en tiempo real con Netdata (bitacora)

Historial de lo aplicado para ver el estado del servidor en tiempo real desde
fuera de la red local. La telemetria agregada al repo privado
(`docs/telemetria.md`) sigue vigente: Netdata es adicional.

Servidor: Ubuntu 26.04 `resolute` con la app `servicio-login` en systemd.
Se instalo Netdata escuchando solo en localhost y se intento Tailscale para el
acceso remoto; Tailscale quedo descartado porque la red del servidor bloquea su
control plane.

## 1. Tailscale (descartado)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

Por que: overlay privado para ver el dashboard desde casa sin abrir puertos.

Diagnostico del bloqueo (se resolvia DNS, pero no conectaba):

```bash
getent ahosts controlplane.tailscale.com
curl -4 -sS --max-time 10 -o /dev/null -w 'controlplane: %{http_code}\n' \
  "https://controlplane.tailscale.com/key?v=148"
sudo tailscale netcheck
sudo journalctl -u tailscaled -n 30 --no-pager
tailscale status
tailscale ip -4
```

Resultado: DNS correcto (`192.200.0.0/24` y `2606:B740:49::/48`, rangos del
control plane de Tailscale desde julio 2025), pero TCP/443 con timeout; los
DERP (`derp1.tailscale.com`) si responden. Log de `tailscaled`:
`fetch control key ... context deadline exceeded`. Es un bloqueo de red
conocido (tailscale/tailscale#16649), no un fallo de la instalacion; se puede
reintentar si la red lo corrige.

## 2. Netdata

```bash
wget -O /tmp/netdata-kickstart.sh https://get.netdata.cloud/kickstart.sh
sudo sh /tmp/netdata-kickstart.sh
```

Por que: monitoreo por segundo (CPU, RAM, disco, red, systemd, logs) y alertas
en un solo comando. Se instalo el canal nightly (2.12.0.197) porque el repo
estable aun no publica para `resolute`; las auto-actualizaciones quedaron
habilitadas por cron.

Escuchar solo en localhost (no exponer 19999 a la red):

```bash
sudo tee /etc/netdata/netdata.conf >/dev/null <<EOF
[web]
    bind to = 127.0.0.1
    allow connections from = localhost
EOF
sudo systemctl restart netdata
```

Verificacion:

```bash
systemctl status netdata --no-pager
sudo ss -ltnp | grep 19999
curl -sS -o /dev/null -w 'netdata local: %{http_code}\n' http://127.0.0.1:19999
sudo journalctl -u netdata -n 60 --no-pager
```

## 3. Pruebas de conectividad saliente

```bash
curl -4 -sS --max-time 10 -o /dev/null -w 'netdata cloud: %{http_code} %{remote_ip}\n' https://app.netdata.cloud/
curl -4 -sS --max-time 10 -o /dev/null -w 'cloudflare: %{http_code}\n' https://api.cloudflare.com/client/v4/
```

Por que: decidir la via de acceso remoto. Ambas responden (200 y 400, que es
respuesta valida): Netdata Cloud y Cloudflare Tunnel quedan viables.

## 4. Netdata Cloud (claim, pendiente)

```bash
sudo sh /tmp/netdata-kickstart.sh --claim-only \
  --claim-token=TOKEN \
  --claim-rooms=ROOM_UUID \
  --claim-url=https://app.netdata.cloud
```

Por que: ver el dashboard desde casa sin abrir puertos (el agente sale hacia
afuera). `TOKEN` y `ROOM_UUID` se copian de `https://app.netdata.cloud`
(Add nodes / Connect node); el room es un UUID, no un texto cualquiera.
`netdata-claim.sh` esta deprecado y su error `one or more room ids are invalid`
es por pasar placeholders sin reemplazar.

## 5. Alternativas de acceso remoto (si no se usa Cloud)

- Tunel SSH (lo mas privado): `sudo apt install openssh-server`, clave publica
  en `~/.ssh/authorized_keys` y desde casa
  `ssh -L 19999:127.0.0.1:19999 <usuario>@<IP_PUBLICA>`, luego
  `http://localhost:19999`. Requiere que la red acepte conexiones entrantes.
- Cloudflare Tunnel: salida por 443, sin abrir puertos; para uso prolijo,
  dominio propio con Cloudflare Access.
- ZeroTier: overlay alternativo a Tailscale (otro control plane, por si este
  no estuviera bloqueado).

## 6. Estado

- Netdata: instalado y corriendo, solo en `127.0.0.1:19999`.
- Acceso remoto: pendiente de claim a Netdata Cloud.
- Tailscale: descartado por bloqueo de la red al control plane.
