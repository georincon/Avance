# srv-auditoria — Centro de auditoría centralizado de las wallets

Un solo lugar donde ver **todo lo que hace cada wallet del ecosistema y cada usuario**, como el extracto de una
aplicación bancaria: quién es, en qué teléfono está, cuándo entró y salió, qué credenciales pidió o presentó, con qué
emisor o verificador, a qué hora, si salió bien y, si falló, por qué.

> Es **monitoreo**: no cambia emisores, listas de confianza ni ningún flujo del ecosistema. La wallet solo *reporta*;
> si el centro no responde, la wallet sigue funcionando y reintenta después.

## Qué incluye

| Pieza | Dónde | Qué hace |
|---|---|---|
| Base PostgreSQL | `db/01-esquema.sql` | Esquema `auditoria`, todo en español. Extracto solo de inserción. |
| API de ingesta | `POST /srv-auditoria/api/v1/eventos` | La usan las wallets (clave `X-Api-Key`). Idempotente por `evento_id`. |
| API de consulta | `GET /srv-auditoria/api/panel/*` | Solo lectura, token `Bearer`. Corre en una transacción `READ ONLY`. |
| Dashboard | `https://civica-desarrollo.avance.org.co/srv-auditoria/` | Panorama, extracto con búsqueda y filtros, usuarios, wallets/dispositivos, emisores y verificadores. Exporta CSV. |

El dashboard (datos personales) solo se abre desde IPs de administración (`srv-nw-nginx/ips-admin-permitidas.conf`);
la ingesta (`/srv-auditoria/api/v1/`) está abierta porque la usan los teléfonos, protegida por su clave.

## Modelo de datos (resumen)

```
usuario ──< medio_contacto            datos personales (cédula) y celular/correo
   └──< wallet ──1:1── dispositivo    la wallet y el TELÉFONO donde corre (fabricante, modelo, Android, RAM, pantalla…)
          ├──< sesion                 cada ingreso/salida (método, inicio, fin, motivo)
          ├──< credencial             lo que tiene/tuvo en la wallet
          └──< actividad >── contraparte (emisor | verificador)
                  └──< actividad_elemento   nombres de datos compartidos (nunca valores)
tipo_actividad  catálogo · consulta_dashboard  quién consultó qué en el panel
```

`actividad` guarda: fecha/hora, tipo, contraparte, credencial, `resultado` (exitoso/fallido/cancelado/en_proceso),
`tipo_error` (red, autenticación, validación, emisor, verificador, usuario, interno), `codigo_error`, `mensaje_error`,
duración y canal (internet, qr, nfc, ble). Un *trigger* impide UPDATE/DELETE.

## Qué reporta la wallet

| Momento | Actividad |
|---|---|
| Termina el onboarding (aprobado) | `registro_usuario` — **alta automática**: datos personales, celular, correo y datos del teléfono |
| Onboarding rechazado / con error | `registro_usuario` fallido (con el motivo) |
| Crea su PIN | `creacion_pin` + primer `inicio_sesion` |
| Entra con PIN o biometría | `inicio_sesion` (exitoso o fallido) |
| Sale o la app pasa a segundo plano | `cierre_sesion` |
| Pide una credencial a un emisor | `solicitud_credencial` + `emision_credencial` (exitosa / fallida / en proceso) |
| Un verificador le pide datos | `solicitud_presentacion` |
| Comparte datos | `presentacion_credencial` (con los nombres de los datos compartidos) |
| Borra una credencial | `eliminacion_credencial` |

Los eventos se guardan primero en una cola en el teléfono y se envían en orden; sin red se conservan y se reenvían.

## Levantar

Entra en el compose raíz (`./up.sh`). Secretos en el `.env` de la raíz (no versionado):
`AUDITORIA_CLAVE_WALLET` (la que lleva la wallet), `AUDITORIA_TOKEN_PANEL` (clave del dashboard), `AUDITORIA_DB_CLAVE`.

Solo este servicio: `docker compose -f srv-auditoria/docker-compose/docker-compose.yaml --env-file .env up -d --build`

La wallet recibe URL y clave al compilar (`app-new-wallet/publicar-wallet.sh` las toma del `.env`):
`-Pnw.auditoria.url=https://<dominio>/srv-auditoria -Pnw.auditoria.clave=<clave>`. Sin ellas el reporte queda apagado.

## Datos de demostración

`AUDITORIA_URL=... AUDITORIA_CLAVE_WALLET=... node scripts/sembrar-demo.mjs 24 30` crea usuarios **ficticios** con 30 días de
actividad usando la propia API de ingesta. No lo uses sobre la base real.

## Privacidad (importante)

Esta base reúne datos personales (cédula, nombre, contactos) y el historial de uso de cada persona. Está pensada para el
entorno de desarrollo/pruebas del ecosistema. Antes de llevarla a producción hay que resolver base legal y
consentimiento (Ley 1581 de 2012), retención, cifrado en reposo y el control de acceso del dashboard; ver
`docs/PROPUESTA-BD-AUDITORIA.md` (sección 10), que advierte de la tensión con el principio de *no vinculación* de eIDAS/ARF.
La clave de la wallet va dentro del APK: sirve para el entorno de pruebas, no es un secreto fuerte.
