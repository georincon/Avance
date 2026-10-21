# proxy-nginx

Contenedor Nginx como punto de entrada HTTP para los servicios web de los proyectos de Avance. Nginx publica el puerto HTTP principal y enruta por prefijo URL a través de la red Docker compartida `avance-proxy`. 

Los overlays de este proyecto conectan los servicios HTTP a la red común y quitan sus puertos publicados en el host. Los archivos Compose originales quedan intactos.

## Rutas

| Prefijo | Proyecto / destino |
| --- | --- |
| `/issuer/pid-registraduria/` | Issuer Registraduría, mediante su HAProxy interno |
| `/issuer/pid-uis/` | Issuer UIS, mediante su HAProxy interno |
| `/pid-issuer/` | Issuer PID de `otros/eudi-srv-pid-issuer` |
| `/verifier/` | Verifier genérico |
| `/spartans/` | Wallet Provider Spartans |
| `/onboarding/` | Backend de onboarding New Wallet |
| `/wallet-provider/` | Wallet Provider New Wallet |
| `/newwallet-status/` | Status list de New Wallet |
| `/addi/onboarding/` | Backend del proyecto Onboarding Addi |
| `/addi/biometrics/` | Servicio biométrico de Onboarding Addi |

Nginx conserva los prefijos que los HAProxy de los issuers necesitan. Para los servicios que sirven desde la raíz, quita el prefijo antes de enviar la petición.

## Iniciar Nginx

```bash
docker network inspect avance-proxy >/dev/null 2>&1 || docker network create avance-proxy
docker compose up -d
```

El gateway y el panel de control quedan disponibles en https://civica-desarrollo.avance.org.co/. El gateway atiende HTTPS en este mismo Nginx.

## Iniciar todos los stacks integrados

Desde esta carpeta:

```bash
./start-all.sh
```

El script inicia Registraduría, UIS, Verifier, New Wallet (onboarding y provider), Spartans, el issuer PID de `otros` y Onboarding Addi con sus overlays, y luego inicia Nginx. Cada stack conserva sus redes internas; los servicios web también se conectan a `avance-proxy`. Las bases de datos quedan privadas dentro de las redes Docker.

Ejemplos:

```text
https://civica-desarrollo.avance.org.co/issuer/pid-registraduria/login
https://civica-desarrollo.avance.org.co/issuer/pid-registraduria/solicitar
https://civica-desarrollo.avance.org.co/issuer/pid-uis/
https://civica-desarrollo.avance.org.co/verifier/actuator/health
https://civica-desarrollo.avance.org.co/onboarding/
https://civica-desarrollo.avance.org.co/wallet-provider/
https://civica-desarrollo.avance.org.co/spartans/
https://civica-desarrollo.avance.org.co/newwallet-status/token_status_list
https://civica-desarrollo.avance.org.co/pid-issuer/
https://civica-desarrollo.avance.org.co/addi/onboarding/
```

## Agregar otro servicio web

Agrega una regla al mapa `$upstream` de `nginx.conf`, crea un overlay en `overrides/` que conecte el servicio a la red externa `avance-proxy` y quite sus puertos publicados. Añade el stack a `start-all.sh` si también debe iniciarse con el script.

Nginx enruta los servicios y termina TLS para civica-desarrollo.avance.org.co. El panel en la raíz se ejecuta desde la carpeta separada panel-control. No se pueden enrutar bases de datos por rutas HTTP.

## Operación

```bash
docker compose logs -f proxy-nginx
docker compose down
```

`docker compose down` detiene únicamente Nginx. Para detener cada stack, ejecuta `docker compose down` desde la carpeta de su Compose usando el mismo overlay empleado al iniciarlo.

El certificado HTTPS se renueva automáticamente con el servicio `certbot-renew`; el proxy recarga Nginx cuando Certbot renueva el certificado.

El panel usa el token guardado en `../panel-control/.env`.
