# Panel de control del ecosistema EUDI de Avance

Plano de control único: desde aquí se levanta, se detiene y se reinicia cada stack del
ecosistema, y se ve su estado real (contando contenedores, no leyendo una lista fija).

Acceso: `https://civica-desarrollo.avance.org.co/` (lo enruta el proxy único `srv-nw-nginx`).

## Un comando para todo

La cabecera del panel tiene dos botones:

| Botón | Qué hace |
|---|---|
| **Levantar todo** | Levanta los nueve stacks del compose raíz y el del issuer de la UIS, con su propio compose |
| **Detener todo** | Los baja todos, sin tocar los volúmenes |

El proxy y el panel **se quedan en pie** en un "Detener todo": el proxy es por donde se entra al
panel (si cayera, la orden se perdería a medio hacer y el navegador nunca vería la respuesta) y
el panel es quien la ejecuta. El proxy devuelve 502 en lo que esté caído, que es justo lo que se
quiere ver.

## Qué gestiona

| Stack | Proyecto | Prefijo de sus rutas |
|---|---|---|
| Issuer Registraduría | `eudi-srv-issuer-pid-registraduria` | `/pid-registraduria`, `/idp` |
| Issuer UIS | `eudi-srv-issuer-pid-uis` | `/uis-issuer`, `/idp-uis` |
| Wallet Provider (único) | `eudi-srv-wallet-provider` | `/wallet-provider` |
| Onboarding | `srv-onboarding` | `/onboarding` |
| Ancla de la app Android | `app-new-wallet` | (no tiene ruta: no es web) |
| Verifiers (banco, contratación, discoteca, EPS) | `verifiers/<nombre>` + su verifier en `verifiers/_comun` | `/<nombre>/` |
| Validador de confianza | `eudi-srv-trust-validator` | `/trust-validator` |
| Publicador de listas | `srv-tl-publisher` | `/tl-publisher` |
| Proxy Nginx (único) | `srv-nw-nginx` | (todo) |

Cada entrada apunta a `<proyecto>/docker-compose/docker-compose.yaml`, que es la convención
del ecosistema: todo proyecto se levanta desde su propia carpeta `docker-compose/`.

## Los dos Keycloak

Los dos emisores (Registraduría y UIS) tienen **su propio** Keycloak, cada uno con su realm:

| Emisor | Keycloak | Realm | Consola |
|---|---|---|---|
| Registraduría | `keycloak-reg` (en su stack) | `pid-registraduria-realm` | `/idp-reg/admin/master/console/` |
| UIS | `keycloak-uis` (en su stack) | `uis-issuer-realm` | `/idp-uis/admin/master/console/` |

### Por qué hace falta "Activar consola"

El proxy público (190.29.100.206) **reescribe el `Path` de todas las cookies a `/`**. Lo hace
así:

```
Set-Cookie: AUTH_SESSION_ID=...;Path=/idp-uis/realms/master/;HttpOnly;SameSite=Lax
   ↓  por el proxy público
Set-Cookie: AUTH_SESSION_ID=...;Path=/; secureidp-uis/realms/master/;HttpOnly;SameSite=Lax
```

El navegador aplica `Path=/` y hace dos cosas: guarda la cookie en la **raíz del dominio** (donde
la comparten las dos instancias) y **ignora** el atributo `secureidp-uis/realms/master/` porque no
es un atributo de cookie válido.

Con las dos instancias en pie, `AUTH_SESSION_ID` y `KC_RESTART` son las mismas para las dos, así que
**entrar en una consola invalida la sesión de la otra** ("Restart login cookie not found"). No es un
fallo del Keycloak: es consecuencia de que las cookies compartan nombre y ruta.

**"Activar consola"** deja en pie el Keycloak que eliges y detiene el del otro emisor, y además pide
al navegador que borre las cookies de sesión de Keycloak (el panel se sirve en el mismo origen, así
que puede hacerlo) para que la primera entrada ya sea limpia.

**Consecuencia a tener en cuenta:** con el Keycloak de un emisor detenido, ese emisor no puede
autenticar a la wallet (su servidor de autorización está caído). Por eso **"Activar consola" es una
acción explícita** y no se hace sola al levantar un stack: por defecto los dos emisores quedan
operativos y la app puede pedir PID y credencial académica a la vez.

### Alternativa，未来: un solo Keycloak

Si el borde público dejara de reescribir el `Path`, los dos Keycloak podrían convivir con sesiones
independientes (y las cookies quedarían aisladas por realm). También valdría un Keycloak con los dos
realms, pero entonces habría **un solo dominio de fallo**: si el IdP cae, caen los dos emisores.
Hoy se ha elegido la вариanza que mantiene cada emisor con su IdP.

## API

Todas las rutas `/api/*` exigen `Authorization: Bearer <CONTROL_PANEL_TOKEN>`.

```bash
# Estado de todos los stacks
curl -sk https://civica-desarrollo.avance.org.co/api/projects \
  -H "Authorization: Bearer $(grep CONTROL_PANEL_TOKEN panel-control/docker-compose/.env | cut -d= -f2)"

# Subir / bajar / reiniciar un stack
curl -sk -X POST https://civica-desarrollo.avance.org.co/api/projects/<id>/action \
  -H "Authorization: Bearer $(grep CONTROL_PANEL_TOKEN panel-control/docker-compose/.env | cut -d= -f2)" \
  -H 'Content-Type: application/json' -d '{"action":"up"}'

# Subir / bajar TODO el ecosistema de una vez
curl -sk -X POST https://civica-desarrollo.avance.org.co/api/all/action \
  -H "Authorization: Bearer $(grep CONTROL_PANEL_TOKEN panel-control/docker-compose/.env | cut -d= -f2)" \
  -H 'Content-Type: application/json' -d '{"action":"up"}'
```

Los `id` son: `issuer-registraduria`, `issuer-uis`, `wallet-provider`, `onboarding`,
`app-new-wallet`, `trust-validator`, `tl-publisher`, `proxy-nginx`.

`/api/all/action` acepta `up`, `down` y `restart`, y devuelve el estado resultante de cada
stack: `{"action":"up","ok":true,"results":[{"id":"...","state":"running","ok":true}, ...]}`.
Si un stack falla, el resto se levanta igualmente y el que falló viene con su `error`.

Además de `up` / `down` / `restart`, los dos emisores aceptan la acción **`activate`**, que deja en
pie su Keycloak y detiene el del otro emisor (ver "Los dos Keycloak").

## Levantar el panel

```bash
docker-compose/up.sh      # crea la red compartida si falta y levanta el panel
docker-compose/down.sh
```

El token se fija en `docker-compose/.env` (`CONTROL_PANEL_TOKEN`, mínimo 32 caracteres).
Copia `docker-compose/.env` a partir de `.env.example` si no existe.

## Permisos

El panel necesita hablar con el demonio de Docker (`/var/run/docker.sock`) y **leer** el árbol
del proyecto (`../..:/home/geovani/Workspace/Avance:ro`). Solo lectura sobre el código: el
demonio de Docker es quien construye las imágenes, no el contenedor del panel.

Además se monta el **Compose del anfitrión** (`/usr/libexec/docker/cli-plugins/docker-compose`),
no el de la imagen. No es un detalle menor: Compose guarda en cada contenedor la etiqueta
`com.docker.compose.version` y, si no coincide con la del cliente que lo maneja, **lo recrea**.
Con dos versiones distintas (la del host y la de la imagen) el panel y la terminal se recrean los
contenedores mutuamente, en bucle, y cada acción del panel reinicia el ecosistema entero.
