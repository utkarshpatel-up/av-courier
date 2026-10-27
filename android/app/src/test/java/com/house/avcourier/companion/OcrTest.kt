package com.house.avcourier.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors tests/ocr.test.js: the same cleaning, and read words still make a request. */
class OcrTest {
    @Test fun cleanDropsSymbolLinesAndSqueezesSpaces() {
        assertEquals("Folder 3046\nHDD 123", Ocr.clean("  Folder   3046 \n | \n—\nHDD 123\n"))
    }

    @Test fun readWordsMakeARequest() {
        val h = Heuristic.heuristic(Ocr.clean("Need raw folder 3046 from HDD 123\nJanmashtami sabha, Ahmedabad 16 Aug 2024"))
        assertTrue(h.isRequest)
    }
}
