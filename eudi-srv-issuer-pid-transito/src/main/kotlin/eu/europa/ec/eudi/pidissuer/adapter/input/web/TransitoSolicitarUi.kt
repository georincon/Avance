/*
 * Código propio de este fork (emulador de la Dirección de Tránsito de Bucaramanga).
 * No es parte del eudi-srv-pid-issuer original de la Comisión Europea.
 * Ver README.md, sección 2 ("Pantalla ciudadana").
 */
package eu.europa.ec.eudi.pidissuer.adapter.input.web

import eu.europa.ec.eudi.pidissuer.adapter.out.transito.Licencia
import arrow.core.raise.effect
import arrow.core.raise.fold
import com.eygraber.uri.Uri
import eu.europa.ec.eudi.pidissuer.adapter.out.attestation.mdl.mdlConfigurationId
import eu.europa.ec.eudi.pidissuer.adapter.out.transito.LicenciaDocumentNumber
import eu.europa.ec.eudi.pidissuer.adapter.out.util.maskDocumentNumber
import eu.europa.ec.eudi.pidissuer.domain.CredentialConfigurationId
import eu.europa.ec.eudi.pidissuer.domain.OpenId4VciSpec
import eu.europa.ec.eudi.pidissuer.port.input.CreateCredentialsOffer
import eu.europa.ec.eudi.pidissuer.port.out.persistence.IsSubjectBlocked
import eu.europa.ec.eudi.pidissuer.port.out.qr.Dimensions
import eu.europa.ec.eudi.pidissuer.port.out.qr.Format
import eu.europa.ec.eudi.pidissuer.port.out.qr.GenerateQqCode
import eu.europa.ec.eudi.pidissuer.port.out.qr.Pixels
import eu.europa.ec.eudi.pidissuer.port.out.transito.FindLicenciaByDocumentNumber
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.web.reactive.function.server.*
import kotlin.io.encoding.Base64

/**
 * Pantalla ciudadana "sin login": el ciudadano escribe su número de cédula y recibe un QR para pedir su
 * licencia de conducción móvil (mDL, ISO 18013-5) con **cualquier wallet EUDI genérica** (a diferencia del flujo
 * automático de onboarding de [OnboardingOffersApi], pensado para la wallet propia `newwallet-app`).
 *
 * Esta pantalla solo genera y muestra la oferta — la verificación real de "quién es quién" ocurre después, cuando
 * la wallet abre la oferta y Keycloak pide de nuevo el número de cédula (sin contraseña: ver
 * `docker-compose/scripts/configurar-login-sin-password.py`).
 *
 * Solo se ofrece a titulares con licencia ACTIVA y al menos una categoría vigente (ver [Licencia.esEmisible]).
 */
class TransitoSolicitarUi(
    private val createCredentialsOffer: CreateCredentialsOffer,
    private val findLicenciaByDocumentNumber: FindLicenciaByDocumentNumber,
    private val generateQrCode: GenerateQqCode,
    private val rateLimit: IpRateLimit = IpRateLimit.disabled(),
    private val isSubjectBlocked: IsSubjectBlocked = IsSubjectBlocked { false },
) {
    val router: RouterFunction<ServerResponse> =
        coRouter {
            GET(SOLICITAR, contentType(MediaType.ALL) and accept(MediaType.TEXT_HTML)) { handleForm(null) }
            POST(
                SOLICITAR,
                contentType(MediaType.APPLICATION_FORM_URLENCODED) and accept(MediaType.TEXT_HTML),
                ::handleSubmit,
            )
        }

    private suspend fun handleForm(error: String?): ServerResponse =
        ServerResponse
            .ok()
            .contentType(MediaType.TEXT_HTML)
            .renderAndAwait("transito-solicitar-form", mapOf("error" to error))

    private suspend fun handleSubmit(request: ServerRequest): ServerResponse {
        // Pantalla pública sin autenticación: cada intento cuenta, y un cliente bloqueado no llega a consultar cédulas.
        rateLimit.blocked(request)?.let { blocked ->
            log.warn("Solicitud de mDL bloqueada por exceso de intentos ({} s restantes)", blocked.retryAfterSeconds)
            return ServerResponse
                .status(HttpStatus.TOO_MANY_REQUESTS)
                .header("Retry-After", blocked.retryAfterSeconds.toString())
                .contentType(MediaType.TEXT_HTML)
                .renderAndAwait(
                    "transito-solicitar-form",
                    mapOf("error" to "Demasiados intentos. Intenta de nuevo en ${(blocked.retryAfterSeconds + 59) / 60} minuto(s)."),
                )
        }
        rateLimit.record(request)

        val documentNumber = request.awaitFormData()["documentNumber"]?.firstOrNull()?.trim().orEmpty()
        if (documentNumber.isBlank()) return handleForm("Debes ingresar tu número de cédula")

        val licencia = findLicenciaByDocumentNumber(LicenciaDocumentNumber(documentNumber))
        // Misma respuesta para "no existe", "no activa", "sin vigencia" y "registro incompleto": el motivo solo queda
        // en el log (enmascarado).
        if (licencia == null) {
            log.info("Solicitud de mDL para cédula no encontrada")
            return handleForm(GENERIC_ERROR)
        }
        if (isSubjectBlocked(licencia.documentNumber.value)) {
            log.info("Solicitud de mDL con emisión bloqueada: {}", documentNumber.maskDocumentNumber())
            return handleForm(GENERIC_ERROR)
        }
        if (!licencia.esEmisible()) {
            log.info(
                "Solicitud de mDL para licencia no emisible ({}): {}",
                licencia.estado,
                documentNumber.maskDocumentNumber(),
            )
            return handleForm(GENERIC_ERROR)
        }

        return effect<CreateCredentialsOffer.Error, Uri> {
            createCredentialsOffer(CreateCredentialsOffer.Request(configurationIdsDe(licencia)))
        }.fold(
            transform = { offerUri ->
                log.info("Oferta de mDL generada para solicitud manual (cédula {})", documentNumber.maskDocumentNumber())
                context(generateQrCode) { offerUri.qrResponse(licencia.nombres, licencia.categorias.joinToString(", ") { it.categoria.codigo }) }
            },
            recover = { error ->
                log.warn("No se pudo generar la oferta para la cédula {}: {}", documentNumber.maskDocumentNumber(), error)
                handleForm("No se pudo generar la oferta de credencial. Intenta de nuevo.")
            },
        )
    }

    companion object {
        const val SOLICITAR: String = "/transito/solicitar"
        /** El Tránsito ofrece un mDL (mso_mdoc) por cada categoría vigente de la licencia. */
        fun configurationIdsDe(licencia: Licencia): Set<CredentialConfigurationId> =
            licencia.categoriasVigentes(java.time.LocalDate.now()).mapTo(linkedSetOf()) { mdlConfigurationId(it.categoria) }

        /**
         * Propiedad que enciende o apaga esta pantalla (por defecto encendida). Apagada, la ruta no se registra y
         * responde 404. Pensada para apagarla en cualquier entorno expuesto: no pide autenticación.
         */
        const val ENABLED_PROPERTY: String = "issuer.transito.solicitar.enabled"

        const val GENERIC_ERROR: String =
            "No fue posible generar la solicitud para esa cédula. Verifica el número o comunícate con la Dirección de Tránsito."
        private val log = LoggerFactory.getLogger(TransitoSolicitarUi::class.java)
    }
}

context(generateQrCode: GenerateQqCode)
private suspend fun Uri.qrResponse(
    nombres: String,
    categorias: String,
): ServerResponse {
    val uri = this@qrResponse
    val qrCode = generateQrCode(uri, Format.PNG, Dimensions(Pixels(300u), Pixels(300u)))
    return ServerResponse
        .ok()
        .contentType(MediaType.TEXT_HTML)
        .renderAndAwait(
            "transito-solicitar-qr",
            mapOf(
                "nombres" to nombres,
                "categorias" to categorias,
                "uri" to uri.toString(),
                "qrCode" to Base64.encode(qrCode),
                "qrCodeMediaType" to "image/png",
                "openid4VciVersion" to OpenId4VciSpec.VERSION,
            ),
        )
}
