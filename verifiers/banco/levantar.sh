#!/usr/bin/env bash
# Levanta el banco y su verifier en el ecosistema Avance. Solo requiere Docker.
#
#   ./levantar.sh        → https://civica-desarrollo.avance.org.co/banco/
#
# 1. Crea .env desde .env.example si no existe.
# 2. Levanta (o actualiza) su verifier, ../_comun/levantar.sh banco, con el nombre del banco y su
#    propósito. El verifier guarda cada presentación (nombre, fecha de nacimiento, foto) solo en
#    memoria y las borra a los 30 minutos; sus solicitudes (el QR) vencen a los 5.
# 3. Levanta el banco en la red avance-eudi y espera a que responda.
#
# Requiere que srv-nw-nginx enrute /banco (→ app-banco:80).

set -euo pipefail
cd "$(dirname "$0")"

[[ -f .env ]] || { echo "▸ Creando .env"; cp .env.example .env; }
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "▸ Verifier del banco (verifier-$VERIFIER_INSTANCIA)"
VERIFIER_NOMBRE="$NOMBRE_BANCO" VERIFIER_PROPOSITO="$PROPOSITO" CONSERVAR_PRESENTACIONES=PT30M VIGENCIA_SOLICITUD=PT5M \
  ../_comun/levantar.sh "$VERIFIER_INSTANCIA" | sed 's/^/  │ /'

echo "▸ Levantando el banco"
mkdir -p datos
export UID_GID="$(id -u):$(id -g)"
docker compose -p banco --env-file .env up -d --build

echo -n "▸ Esperando al banco"
for _ in $(seq 1 60); do
  if curl -skf -o /dev/null "https://localhost/$PREFIJO/salud"; then
    echo " listo."
    cat <<MSG

  Banco                https://$DOMINIO/$PREFIJO/
  Su verifier          https://$DOMINIO/verifier-$VERIFIER_INSTANCIA/
  Clientes             datos/clientes.json   (datos personales de la prueba: bórralo para empezar de cero)

  Logs:                docker compose -p banco logs -f
MSG
    exit 0
  fi
  echo -n "."
  sleep 2
done
echo " no respondió en 2 minutos. Revisa: docker compose -p banco logs"
exit 1
