# nw-nginx — punto de entrada único del ecosistema EUDI de Avance

Nginx es el **único** servicio que publica puertos en el host (80 y 443). Todo lo demás vive
detrás de él, en la red Docker compartida `avance-eudi`, y se alcanza por nombre de servicio.

Con esto el ecosistema se usa siempre por el dominio `civica-desarrollo.avance.org.co`, sin IPs
sueltas: el mismo acceso desde la LAN y desde fuera de ella.

## Cómo llega el tráfico

```
Teléfono / navegador
        │  https://civica-desarrollo.avance.org.co
        ▼
Proxy público  (190.29.100.206, nginx, certificado *.avance.org.co)
        │  reenvía 80 y 443 a este equipo
        ▼
nw-nginx  (este proyecto, 192.168.0.240:443)
        │  enruta por prefijo de ruta
        ├── /wallet-provider/*   → spartans-wallet-provider:8080
        ├── /onboarding/*         → onboarding-backend:8095
        ├── /biometrics/*         → onboarding-biometrics:8100
        ├── /pid-registraduria/*  → haproxy-reg:80
        ├── /idp-reg/*             → haproxy-reg:80
        ├── /uis-issuer/*         → haproxy-uis:80
        ├── /idp-uis/*            → haproxy-uis:80
        ├── /verifier/*           → avance-verifier-api:8080
        ├── /trust-validator/*    → trust-validator:8080
        ├── /tl-publisher/*, /TL/*, /LOTL/*  → tl-publisher:8080
        ├── /pki/*                → tl-publisher-pki:8080
        ├── /status-list/wallet-provider/*    → status-list-spartans:5000
        ├── /status-list/pid-registraduria/* → status-list-reg:5000
        ├── /status-list/uis-issuer/*         → status-list-uis:5000
        └── (resto)               → avance-control-panel:4173
```

El proxy público **no invierte TLS**: termina TLS con el certificado de producción
`*.avance.org.co` y reenvía a este puerto 443. Aquí el salto es con el certificado local de
desarrollo (`certs/live/civica-desarrollo.avance.org.co/`), que el borde no verifica.

## Rutas

| Prefijo | Servicio | Proyecto |
|---|---|---|
| `/wallet-provider/` | Wallet Provider (WUA + Key Attestations) | `eudi-srv-wallet-provider` |
| `/.well-known/oauth-protected-resource` | Metadata RFC 9728 del provider | `eudi-srv-wallet-provider` |
| `/jwks` | JWKS del provider | `eudi-srv-wallet-provider` |
| `/onboarding/` | Onboarding de usuario (identity proofing) | `onboarding` |
| `/biometrics/` | Servicio de visión (rostro/OCR) | `onboarding` |
| `/pid-registraduria/` | Issuer PID (OpenID4VCI) | `eudi-srv-pid-registraduria` |
| `/idp/` | Keycloak | `eudi-srv-pid-registraduria` |
| `/status-list/wallet-provider/` | Lista de estado del provider | `eudi-srv-wallet-provider` |
| `/status-list/pid-registraduria/` | Lista de estado del issuer | `eudi-srv-pid-registraduria` |
| `/` | Panel de control local | `panel-control` |

**Regla de oro:** *la URL que declara `ISSUER_PUBLICURL` es exactamente la que enruta este proxy.*

## Uso

```bash
./scripts/generar-certificados.sh   # PKI local del proxy (una vez)
docker-compose/up.sh                 # crea la red compartida si falta y levanta nginx
docker-compose/down.sh               # detiene
```

Cambios en `nginx.conf` se aplican con `docker exec nw-nginx nginx -s reload` (la config es un
bind mount, no hace falta recrear el contenedor).

## Red compartida

La red `avance-eudi` es **externa**: no pertenece a ningún proyecto y no se borra al hacer
`docker compose down`. Cada stack se conecta declarándola:

```yaml
networks:
  avance-eudi:
    name: avance-eudi
    external: true
```

Así ningún proyecto depende del ciclo de vida de otro, y el proxy alcanza todos los servicios por
nombre. La crea `up.sh` de este proyecto (o el de cada stack) si no existe.

## Certificate renewal

`certbot-renew` renueva el certificado local y recarga nginx. Para el entorno de desarrollo
actual el certificado del borde (`*.avance.org.co`) es el que ve el cliente, así que la
renovación local es opcional; el contenedor está por si se quiere un certificado propio válido
para el dominio.
