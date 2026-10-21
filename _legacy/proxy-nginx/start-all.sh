#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AVANCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"


docker network inspect avance-proxy >/dev/null 2>&1 || docker network create avance-proxy >/dev/null

start_stack() {
  local directory="$1"
  local compose_file="$2"
  local overlay="$3"
  local stack_dir="$AVANCE_ROOT/$directory"

  printf 'Iniciando %s\n' "$directory"
  (cd "$stack_dir" && docker compose -f "$compose_file" -f "$SCRIPT_DIR/$overlay" up -d --build)
}

start_stack eudi-srv-issuer-pid-registraduria/docker-compose docker-compose.yaml overrides/registraduria.yaml
start_stack eudi-srv-issuer-pid-uis/docker-compose docker-compose.yaml overrides/uis.yaml
start_stack eudi-srv-verifier-generic/docker-compose docker-compose.yaml overrides/verifier.yaml
start_stack eudi-app-wallet-new_wallet/docker-compose docker-compose.yaml overrides/newwallet.yaml
start_stack eudi-srv-wallet-provider/docker docker-compose.yaml overrides/spartans.yaml
start_stack otros/eudi-srv-pid-issuer/docker-compose docker-compose.yaml overrides/pid-issuer.yaml
start_stack otros/addi/OnboardingAddi/docker-compose docker-compose.yaml overrides/onboarding.yaml

docker compose -f "$SCRIPT_DIR/docker-compose.yaml" up -d
printf '\nNginx y todos los stacks integrados están iniciados.\n'
