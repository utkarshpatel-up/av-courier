package com.house.avcourier.companion

import android.content.Context
import android.net.Uri
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

/**
 * Reads the words in a picture on this phone (Google ML Kit, offline and free): a photo of a
 * monitor, a screenshot, a poster. English and Hindi; ML Kit has no Gujarati. It reads letters
 * only: the request reader (Heuristic) and the catalogue search make sense of them.
 */
object Ocr {
    private val latin by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    private val devanagari by lazy { TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build()) }
    private val DEVANAGARI_CHAR = Regex("[\\u0900-\\u097F]")

    /** Blocking: call it off the main thread. */
    fun read(ctx: Context, uri: Uri): String {
        val img = InputImage.fromFilePath(ctx, uri)
        val lines = Tasks.await(latin.process(img)).textBlocks.flatMap { b -> b.lines.map { it.text } }.toMutableList()
        // Hindi lines come from the Devanagari reader; its Latin lines repeat the ones above.
        try {
            Tasks.await(devanagari.process(img)).textBlocks.flatMap { b -> b.lines.map { it.text } }
                .filter { DEVANAGARI_CHAR.containsMatchIn(it) }.forEach { lines.add(it) }
        } catch (e: Exception) {
            // Hindi model unavailable: English is still there
        }
        return clean(lines.joinToString("\n"))
    }

    /** Same cleaning as electron/ocr.js: squeeze spaces, drop lines of lone symbols. */
    fun clean(text: String): String =
        text.split('\n').map { it.replace(Regex("\\s+"), " ").trim() }
            .filter { l -> l.count { it.isLetterOrDigit() } >= 2 }
            .joinToString("\n")
}
