# Onboarding

Servicio de **onboarding de usuario** (*identity proofing*): captura del documento, OCR, selfie
con liveness, verificación de contacto (OTP) y consentimiento.

Vive en su propio proyecto, y no dentro de una wallet, porque es **transversal**: cualquier
wallet del ecosistema lo usa para dar de alta al usuario antes de pedir credenciales. Así no se
duplica al clonar o re-clonar una wallet, y puede evolucionar y versionarse por separado.

> Antes estaba duplicado en tres sitios (`new-wallet/onboarding`, `Avance/addi-onboarding`,
> `Avance_II/OnboardingAddi`), sin versionar en git. Ahora hay una sola copia.

## Acceso

- Público: `https://civica-desarrollo.avance.org.co/onboarding` (a través del proxy único
  `Avance/nw-nginx`).
- API: `POST /api/v1/onboarding/sessions` y `GET /api/v1/onboarding/sessions/{id}`.
- Biometría (rostro/OCR): `https://civica-desarrollo.avance.org.co/biometrics` (interno).

## Composición

| Servicio | Función | Puerto host |
|---|---|---|
| `onboarding-backend` | API Spring Boot | — (vía proxy) |
| `onboarding-biometrics` | Visión: rostro + OCR (Python/OpenCV) | — (vía proxy) |
| `onboarding-postgres` | Base de datos | — (privada, nunca enrutada) |

## Uso

```bash
./up.sh      # crea la red compartida si falta y levanta el stack
./down.sh    # detiene
```

Variables opcionales (`.env`):

| Variable | Por defecto | Para qué |
|---|---|---|
| `ONBOARDING_DB_PASSWORD` | `onboarding` | Contraseña del Postgres |
| `OTP_EXPOSE_CODE` | `true` | Solo desarrollo: devuelve el código OTP en la respuesta |
| `OTP_HASH_PEPPER` | `dev-pepper-change-me` | Pepper del hash del OTP (cámbialo en cualquier entorno real) |
