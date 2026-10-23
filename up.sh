#!/usr/bin/env bash
#
# Levanta TODO el ecosistema EUDI de Avance de una vez.
#
#   ./up.sh            levanta el ecosistema entero (los 10 stacks, UIS incluido)
#   ./up.sh --sin-uis  levanta solo los 9 stacks del compose raiz (sin el issuer UIS)
#   ./up.sh --sin-portales   no levanta los portales de ejemplo de verifiers/
#   ./up.sh --build    reconstruye las imagenes antes de levantar
#   ./up.sh --help     esta ayuda
#
# Es idempotente: se puede ejecutar tantas veces como haga falta. Si un stack ya
# esta en pie, lo deja como estaba.
#
# QUE SE LEVANTA
#
# El compose raiz reune nueve stacks (identidad, wallet, onboarding, confianza,
# verificador, proxy y panel). El décimo, el issuer de la UIS, vive en su propio
# proyecto: no esta en el compose raiz porque es el que mas recursos consume (su
# Keycloak, sus dos Postgres y su issuer) y el que se para cuando se trabaja con
# el de la Registraduria.
#
# Este script levanta LOS DOS: primero el compose raiz y despues el stack de la
# UIS con su propio compose. Con --sin-uis se queda solo con el compose raiz.
#
# Despues levanta los portales de ejemplo de verifiers/ (discoteca, banco, contratacion,
# EPS, notaria, aerolinea, inscripcion y becas, control de acceso), cada uno con su
# verifier: lo hace verifiers/levantar-portales.sh. Un portal que nunca se creo no se
# crea aqui (su levantar.sh lo hace la primera vez). Con --sin-portales se omiten.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Las redes. No pertenecen a ningun proyecto: `docker compose down` no las
# borra. Cada stack tiene la suya, para que no compartan red (el issuer de la
# Registraduria no tiene por que poder alcanzar el Postgres de la UIS), y la
# compartida `avance-eudi` es por donde el proxy unico llega a todos.
#
# Son externas en los composes: las gestiona este script, no Compose. Asi el
# compose raiz y el de cada stack usan las mismas sin pelearse con las
# etiquetas de proyecto.
REDES=(
  avance-eudi                  # la compartida
  newwallet_default            # app-new-wallet
  nw-nginx_default             # srv-nw-nginx
  onboarding_default           # srv-onboarding
  registraduria_default        # eudi-srv-issuer-pid-registraduria
  spartans_default             # eudi-srv-wallet-provider
  srv-tl-publisher_default      # srv-tl-publisher
  avance-verifier_default      # eudi-srv-verifier-local-build
)
REDES_UIS=(
  uis-issuer_default           # eudi-srv-issuer-pid-uis
)

# Los argumentos. Los que son de este script se separa de los de Compose.
CON_UIS=1
CON_PORTALES=1
BUILD=()
AYUDA=0
ARGUMENTOS_COMPOSE=()

while [ $# -gt 0 ]; do
  case "$1" in
    --sin-uis|--no-uis) CON_UIS=0 ;;
    --sin-portales)      CON_PORTALES=0 ;;
    --build)             BUILD=(--build) ;;
    -h|--help)           AYUDA=1 ;;
    *)                   ARGUMENTOS_COMPOSE+=("$1") ;;
  esac
  shift
done

if [ "$AYUDA" -eq 1 ]; then
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

crear_red() {
  local red="$1"
  if ! docker network inspect "$red" >/dev/null 2>&1; then
    echo ">> Creando la red '$red'..."
    docker network create "$red" >/dev/null
  fi
}

for red in "${REDES[@]}"; do crear_red "$red"; done
if [ "$CON_UIS" -eq 1 ]; then
  for red in "${REDES_UIS[@]}"; do crear_red "$red"; done
fi

# El ecosistema. El compose raiz incluye cada stack con su propio fichero.
echo ">> Levantando el ecosistema..."
docker compose up -d "${BUILD[@]}" "${ARGUMENTOS_COMPOSE[@]}"

# El stack de la UIS, con su propio compose: no esta en el compose raiz.
if [ "$CON_UIS" -eq 1 ]; then
  echo ">> Levantando el issuer de la UIS..."
  docker compose -f eudi-srv-issuer-pid-uis/docker-compose/docker-compose.yaml \
    up -d "${BUILD[@]}" "${ARGUMENTOS_COMPOSE[@]}"
fi

# Los portales de ejemplo, cada uno con su verifier. Van despues: necesitan la red
# compartida y, para verificar, los emisores y las listas de estado.
if [ "$CON_PORTALES" -eq 1 ]; then
  echo ">> Levantando los portales de ejemplo..."
  verifiers/levantar-portales.sh "${BUILD[@]}" || echo "   (algun portal no subio: ver arriba)"
fi

# Que se vea.
echo
docker compose ps --format "table {{.Service}}\t{{.Status}}"
if [ "$CON_UIS" -eq 1 ]; then
  echo
  docker compose -f eudi-srv-issuer-pid-uis/docker-compose/docker-compose.yaml \
    ps --format "table {{.Service}}\t{{.Status}}"
fi

echo
echo "Ecosistema disponible en https://civica-desarrollo.avance.org.co"
echo "El panel de control, en la raiz del dominio."
if [ "$CON_PORTALES" -eq 1 ]; then
  echo "Portales: /discoteca /banco /contratacion /eps /notaria /aerolinea /beca /acceso /pensiones /cancilleria"
fi
if [ "$CON_UIS" -eq 0 ]; then
  echo "El issuer de la UIS queda fuera; para levantarlo:"
  echo "  docker compose -f eudi-srv-issuer-pid-uis/docker-compose/docker-compose.yaml up -d"
fi
