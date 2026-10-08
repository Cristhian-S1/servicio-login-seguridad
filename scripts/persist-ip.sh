#!/usr/bin/env bash
# Persiste una IP secundaria en la VM (NetworkManager o netplan).
#
# Uso:
#   IP_CIDR=192.168.102.91/24 IFACE=ens18 npm run ip:persist
#   sudo bash scripts/persist-ip.sh 192.168.102.91/24 ens18
#
# IFACE es opcional: si se omite se detecta la interfaz con la ruta default.
set -euo pipefail

IP_CIDR="${1:-${IP_CIDR:-}}"
IFACE="${2:-${IFACE:-}}"

if [ -z "$IP_CIDR" ]; then
  echo "ERROR: falta la IP. Usa: IP_CIDR=192.168.102.91/24 npm run ip:persist" >&2
  exit 1
fi

if ! [[ "$IP_CIDR" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then
  echo "ERROR: '$IP_CIDR' no tiene formato IP/prefijo (ej: 192.168.102.91/24)" >&2
  exit 1
fi

IP_ONLY="${IP_CIDR%%/*}"

if [ -z "$IFACE" ]; then
  IFACE="$(ip route show default | awk '{print $5; exit}')"
fi

if [ -z "$IFACE" ]; then
  echo "ERROR: no se pudo detectar la interfaz. Pasa IFACE=ens18" >&2
  exit 1
fi

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

echo "Interfaz......: $IFACE"
echo "IP a persistir: $IP_CIDR"

if ip -br addr show "$IFACE" | grep -qw "$IP_ONLY"; then
  echo "La IP ya esta activa en $IFACE."
else
  as_root ip addr add "$IP_CIDR" dev "$IFACE"
  echo "IP agregada en caliente."
fi

if systemctl is-active --quiet NetworkManager 2>/dev/null && command -v nmcli >/dev/null 2>&1; then
  CONN="$(nmcli -t -f NAME,DEVICE connection show --active | awk -F: -v d="$IFACE" '$2 == d { print $1; exit }')"
  if [ -z "$CONN" ]; then
    echo "ERROR: NetworkManager no reporta una conexion activa para $IFACE." >&2
    exit 1
  fi

  CURRENT="$(nmcli -g ipv4.addresses connection show "$CONN" || true)"
  if echo "$CURRENT" | grep -q "$IP_ONLY"; then
    echo "NetworkManager ya tiene la IP en la conexion '$CONN'."
  else
    as_root nmcli connection modify "$CONN" +ipv4.addresses "$IP_CIDR"
    as_root nmcli connection up "$CONN" >/dev/null
    echo "IP persistida en NetworkManager (conexion '$CONN')."
  fi
elif command -v netplan >/dev/null 2>&1; then
  echo "NetworkManager no esta activo; netplan necesita editar el YAML de la interfaz." >&2
  echo "Agrega '$IP_CIDR' bajo la interfaz $IFACE en /etc/netplan/*.yaml y ejecuta:" >&2
  echo "  sudo netplan apply" >&2
  exit 1
else
  echo "ERROR: no se detecto NetworkManager ni netplan. Configura la IP manualmente." >&2
  exit 1
fi

echo "Verificando..."
ip -br addr show "$IFACE"

if curl -fsS --max-time 3 "http://$IP_ONLY:3000/health" >/dev/null 2>&1; then
  echo "OK: el servicio responde en http://$IP_ONLY:3000/health"
else
  echo "Aviso: el servicio aun no responde en http://$IP_ONLY:3000 (arrancalo con npm run vm:setup o npm run deploy)."
fi
