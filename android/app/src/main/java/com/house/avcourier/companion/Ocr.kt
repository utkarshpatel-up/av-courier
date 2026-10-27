package com.house.avcourier.companion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.File

/**
 * Reads the words in a picture on this phone, offline and free: a photo of a monitor, a
 * screenshot, a poster. Tesseract reads Gujarati and English (the same engine and language
 * files as the PC, electron/ocr.js); Google ML Kit reads Hindi. It reads letters only: the
 * request reader (Heuristic) and the catalogue search make sense of them.
 */
object Ocr {
    private val devanagari by lazy { TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build()) }
    private val DEVANAGARI_CHAR = Regex("[\\u0900-\\u097F]")
    private val GUJARATI_CHAR = Regex("[\\u0A80-\\u0AFF]")
    private val LANGS = listOf("guj", "eng")
    // Longest side for Tesseract: sharp enough for screen text, quick enough on a phone.
    private const val MAX_SIDE = 2400

    /** Blocking: call it off the main thread. */
    fun read(ctx: Context, uri: Uri): String {
        val lines = tesseract(ctx, uri).split('\n').toMutableList()
        // Hindi from ML Kit. Its "Hindi" on a Gujarati picture is Gujarati misread: left out.
        val gujarati = lines.any { GUJARATI_CHAR.containsMatchIn(it) }
        try {
            val hindi = Tasks.await(devanagari.process(InputImage.fromFilePath(ctx, uri))).textBlocks.flatMap { b -> b.lines.map { it.text } }
            if (lines.none { it.isNotBlank() }) lines.addAll(hindi) // Tesseract found nothing: ML Kit's reading (it reads English too)
            else if (!gujarati) lines.addAll(hindi.filter { DEVANAGARI_CHAR.containsMatchIn(it) })
        } catch (e: Exception) {
            // Hindi model unavailable: Gujarati and English are still there
        }
        return clean(lines.joinToString("\n"))
    }

    private fun tesseract(ctx: Context, uri: Uri): String {
        val bmp = bitmap(ctx, uri)
        val api = TessBaseAPI()
        try {
            if (!api.init(dataDir(ctx).absolutePath, LANGS.joinToString("+"), TessBaseAPI.OEM_LSTM_ONLY)) return ""
            api.setImage(bmp)
            return api.getUTF8Text().orEmpty()
        } finally {
            api.recycle()
            bmp.recycle()
        }
    }

    /** The language files ship in the APK; Tesseract wants them as plain files in <dir>/tessdata. */
    private fun dataDir(ctx: Context): File {
        val root = File(ctx.filesDir, "ocr")
        val tess = File(root, "tessdata").apply { mkdirs() }
        for (l in LANGS) {
            val f = File(tess, "$l.traineddata")
            if (f.length() > 0) continue
            val tmp = File(tess, "$l.part")
            ctx.assets.open("tessdata/$l.traineddata").use { input -> tmp.outputStream().use { input.copyTo(it) } }
            tmp.renameTo(f)
        }
        return root
    }

    /** The picture upright (camera photos carry their rotation separately), scaled down if huge. */
    private fun bitmap(ctx: Context, uri: Uri): Bitmap {
        if (Build.VERSION.SDK_INT >= 28) {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { d, info, _ ->
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // Tesseract reads the pixels
                val side = maxOf(info.size.width, info.size.height)
                if (side > MAX_SIDE) d.setTargetSampleSize((side + MAX_SIDE - 1) / MAX_SIDE)
            }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        ctx.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
        val side = maxOf(bounds.outWidth, bounds.outHeight)
        val opts = BitmapFactory.Options().apply { inSampleSize = maxOf(1, (side + MAX_SIDE - 1) / MAX_SIDE) }
        return ctx.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, opts) }
            ?: throw IllegalArgumentException("Not a picture")
    }

    /** Same cleaning as electron/ocr.js: squeeze spaces, drop lines of lone symbols. */
    fun clean(text: String): String =
        text.split('\n').map { it.replace(Regex("\\s+"), " ").trim() }
            .filter { l -> l.count { it.isLetterOrDigit() } >= 2 }
            .joinToString("\n")
}
