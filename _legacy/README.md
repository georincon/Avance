# `_legacy/` — instantáneas anteriores a la consolidación

**Nada de esta carpeta forma parte del ecosistema en ejecución.** No hay ningún
`docker compose` que la use, ningún servicio la consulta y el proxy no la
enruta. Es material de referencia y reversibilidad.

## Qué hay aquí

| Carpeta | Qué es | Por qué está |
|---|---|---|
| `OnboardingAddi/` | Tercera copia del onboarding (la que tenía `android/`, `tools/.venv` y los APK de entrega) | El onboarding canónico es `../srv-onboarding/`. De aquí se integró lo que faltaba (`docs/`, `ESTADO.md`, `deliveries/`, `muestras/`) antes de retirar el resto. |
| `eudi-app-wallet-new_wallet/` | La wallet antes de renombrarse a `app-new-wallet/` | Contenía `backend/` con el clon del Wallet Provider y el override del trust-validator que apuntaba a **producción**. Ambos se eliminaron. |
| `eudi-srv-issuer-pid-registraduria/` | El issuer de la Registraduría antes de la consolidación | Su compose publicaba `443` y usaba la red `registraduria_default` en vez de la compartida. |
| `eudi-srv-issuer-pid-uis/` | El issuer de la UIS antes de la consolidación | Publicaba `80` y `443` (colisión directa con el proxy) y usaba `/idp`, que ya estaba ocupado por el Keycloak de la Registraduría. |
| `eudi-srv-verifier-generic/` | La primera versión del verifier | Superada por `../eudi-srv-verifier-local-build/`. |
| `eudi-srv-wallet-provider/` | El Wallet Provider antes de la consolidación | Configuración y PKI propias, ya sustituidas por `../eudi-srv-wallet-provider/`. |
| `panel-control/` | El panel antes de la consolidación | Apuntaba a carpetas de la era `Avance_II` y no encontraba ningún stack. |
| `proxy-nginx/` | El gateway original (nginx + Let's Encrypt + overrides) | Sustituido por `../srv-nw-nginx/`, que es el proxy único actual. |
| `addi-imagenes/` | Imágenes de prueba del onboarding | Copia de las imágenes de `srv-onboarding/imagenes-test/`. |
| `otros-residual/eudi-srv-pid-issuer/` | El PID issuer "vanilla" del upstream | El fork de la Registraduría es superconjunto suyo: no se aporta nada que no esté ya en `../eudi-srv-issuer-pid-registraduria/`. |

## Cómo se recuperó cada cosa

Todos los proyectos de aquí son repositorios git con su historia. Nada se perdió:
cada cambio que se aplicó en la versión canónica está en el repositorio de
`Avance/`, y lo que se descartó está en el historial de estos repositorios.

## Recomendación

Esta carpeta ocupa varios gigabytes y no aporta nada al runtime. Se puede
borrar sin riesgo una vez que se confirme que no hace falta ninguna referencia
histórica. **No se ha borrado** porque el material es la única red de seguridad
de cambios que no se pudieron portar al deriva.

Antes de borrarla, conviene comprobar que ningún repositorio de `Avance/` la
menciona:

```bash
grep -rn "_legacy\|Avance_II" --include="*.md" --include="*.sh" --include="*.yaml" --include="*.js" \
  --exclude-dir=_legacy --exclude-dir=.git .
```
