# Centro de control Avance

Panel de administración de los stacks de Avance. Se mantiene como proyecto separado y se sirve en la raíz del dominio mediante `proxy-nginx`.

## Despliegue

Desde esta carpeta:

```bash
docker compose up -d --build
```

El token de acceso se guarda en `.env`. No lo subas al repositorio.

## Acceso

Abre https://civica-desarrollo.avance.org.co/. Ingresa el token de `.env` cuando el panel lo solicite. El panel administra los stacks con Docker Compose y sus overrides en `../proxy-nginx/overrides`.
