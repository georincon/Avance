package com.onboarding.provider.impl

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.client.j2se.BufferedImageLuminanceSource
import com.google.zxing.common.GlobalHistogramBinarizer
import com.google.zxing.common.HybridBinarizer
import com.onboarding.provider.DocumentOcrProvider
import com.onboarding.provider.ExtractedIdData
import com.onboarding.provider.OcrResult
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.awt.geom.AffineTransform
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.time.LocalDate
import java.time.Period
import javax.imageio.ImageIO

/**
 * Lectura real del reverso de la cedula amarilla: decodifica el codigo de
 * barras PDF417 con ZXing (probando rotaciones, binarizadores y escalas) y
 * parsea los campos segun los offsets documentados de la Registraduria.
 *
 * Un documento solo es "valido" si los campos leidos tienen sentido (numero,
 * nombres, fecha de nacimiento plausible). La confianza se calcula segun los
 * campos obtenidos; no es un valor fijo.
 *
 * Nota: la nueva Cedula Digital (QR) requiere otra estrategia.
 */
@Component
class Pdf417OcrProvider : DocumentOcrProvider {
    private val log = LoggerFactory.getLogger(javaClass)
    override val name = "pdf417"

    private val hints = mapOf(
        DecodeHintType.TRY_HARDER to true,
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.PDF_417),
    )

    override fun extract(frontImage: ByteArray, backImage: ByteArray?, contentType: String?): OcrResult {
        val back = backImage
            ?: return OcrResult(ExtractedIdData(), 0.0, false, "Falta la imagen del reverso")
        return runCatching {
            val raw = decodePdf417(back)
            val data = parseCedula(raw)
            validate(data)
        }.getOrElse { ex ->
            log.warn("No se pudo leer el PDF417 del reverso: {}", ex.message)
            OcrResult(ExtractedIdData(), 0.0, false, "No se pudo leer el codigo de barras del reverso: ${ex.message}")
        }
    }

    // ------------------------------------------------------------ decodificacion

    private fun decodePdf417(bytes: ByteArray): String {
        val original = ImageIO.read(ByteArrayInputStream(bytes)) ?: error("imagen invalida")
        val reader = MultiFormatReader().apply { setHints(hints) }
        for (scale in listOf(1.0, 0.5)) {
            val base = if (scale == 1.0) original else scale(original, scale)
            for (quarterTurns in 0..3) {
                val img = rotate(base, quarterTurns)
                for (binarizer in listOf<(BufferedImageLuminanceSource) -> com.google.zxing.Binarizer>(
                    { HybridBinarizer(it) },
                    { GlobalHistogramBinarizer(it) },
                )) {
                    val bitmap = BinaryBitmap(binarizer(BufferedImageLuminanceSource(img)))
                    try {
                        val result = reader.decodeWithState(bitmap)
                        val rawBytes = result.rawBytes
                        return if (rawBytes != null && rawBytes.isNotEmpty()) {
                            String(rawBytes, Charsets.ISO_8859_1)
                        } else {
                            result.text ?: error("contenido vacio")
                        }
                    } catch (_: NotFoundException) {
                        // siguiente combinacion
                    } finally {
                        reader.reset()
                    }
                }
            }
        }
        error("sin codigo PDF417 detectable")
    }

    private fun scale(img: BufferedImage, factor: Double): BufferedImage {
        val w = (img.width * factor).toInt().coerceAtLeast(1)
        val h = (img.height * factor).toInt().coerceAtLeast(1)
        val out = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        val g = out.createGraphics()
        g.setRenderingHint(java.awt.RenderingHints.KEY_INTERPOLATION, java.awt.RenderingHints.VALUE_INTERPOLATION_BILINEAR)
        g.drawImage(img, 0, 0, w, h, null)
        g.dispose()
        return out
    }

    private fun rotate(img: BufferedImage, quarterTurns: Int): BufferedImage {
        if (quarterTurns % 4 == 0) return img
        val turns = quarterTurns % 4
        val swap = turns % 2 == 1
        val w = if (swap) img.height else img.width
        val h = if (swap) img.width else img.height
        val tx = AffineTransform().apply {
            translate(w / 2.0, h / 2.0)
            rotate(Math.toRadians(90.0 * turns))
            translate(-img.width / 2.0, -img.height / 2.0)
        }
        val out = BufferedImage(w, h, BufferedImage.TYPE_INT_RGB)
        val g = out.createGraphics()
        g.drawImage(img, tx, null) // funciona con cualquier tipo de imagen de origen
        g.dispose()
        return out
    }

    // ------------------------------------------------------------------- parseo

    /** Offsets documentados (Registraduria) sobre el arreglo crudo de bytes. */
    private fun parseCedula(raw: String): ExtractedIdData {
        require(raw.length >= 168) { "payload PDF417 demasiado corto (${raw.length})" }

        fun clean(start: Int, end: Int): String =
            raw.substring(start, end).map { if (it == '\u0000' || it == '�') ' ' else it }
                .joinToString("")

        fun field(start: Int, end: Int): String =
            clean(start, end).trim().trim('+', '-', '.', ' ').replace(Regex("\\s+"), " ")

        val docNumber = field(48, 58).filter { it.isDigit() }.trimStart('0').ifEmpty { null }
        val year = field(152, 156).filter { it.isDigit() }
        val month = field(156, 158).filter { it.isDigit() }
        val day = field(158, 160).filter { it.isDigit() }
        val birthDate = runCatching {
            if (year.length == 4) LocalDate.of(year.toInt(), month.toInt(), day.toInt()) else null
        }.getOrNull()

        val genderChar = field(151, 152).take(1).uppercase()
        // El signo del Rh (+/-) forma parte del dato: no se recorta.
        val bloodType = clean(166, 168).trim().uppercase().takeIf { Regex("^(A|B|AB|O)[+-]?$").matches(it) }

        return ExtractedIdData(
            documentNumber = docNumber,
            firstName = field(104, 127).ifBlank { null },
            middleName = field(127, 150).ifBlank { null },
            lastName = field(58, 80).ifBlank { null },
            secondLastName = field(81, 104).ifBlank { null },
            birthDate = birthDate,
            gender = when (genderChar) {
                "M" -> "MALE"
                "F" -> "FEMALE"
                else -> null
            },
            bloodType = bloodType,
            expeditionPlace = null,
            issueDate = null,
            rawText = null, // no se conserva el payload crudo (dato personal)
        )
    }

    /** Verifica que los campos tengan sentido y calcula la confianza segun lo leido. */
    private fun validate(d: ExtractedIdData): OcrResult {
        val problems = mutableListOf<String>()
        if (d.documentNumber == null || d.documentNumber.length !in 5..10) problems += "numero de documento invalido"
        if (d.firstName.isNullOrBlank()) problems += "falta el nombre"
        if (d.lastName.isNullOrBlank()) problems += "falta el primer apellido"
        val birth = d.birthDate
        if (birth == null) {
            problems += "fecha de nacimiento ilegible"
        } else {
            val age = Period.between(birth, LocalDate.now()).years
            if (birth.isAfter(LocalDate.now()) || age < 14 || age > 110) problems += "fecha de nacimiento no plausible"
        }
        val present = listOf(d.documentNumber, d.firstName, d.lastName, d.birthDate, d.gender, d.bloodType)
            .count { it != null && it.toString().isNotBlank() }
        val confidence = if (problems.isEmpty()) 0.4 + 0.6 * present / 6.0 else 0.2 * present / 6.0
        return OcrResult(
            data = d,
            confidence = confidence,
            documentValid = problems.isEmpty(),
            details = if (problems.isEmpty()) "PDF417 decodificado" else "PDF417 leido pero invalido: ${problems.joinToString(", ")}",
        )
    }
}
