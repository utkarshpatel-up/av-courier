package com.house.avcourier.companion

import org.junit.Assert.assertEquals
import org.junit.Test

// Mirrors tests/remote.test.js 'WhatsApp replies carry the message they answer'.
class SenderTest {
    @Test
    fun repliesQuoteTheMessageTheyAnswer() {
        assertEquals("> Bhai folder 3046 no data joie che\n\nHi Ravi, here is where it is",
            Sender.withQuote("Hi Ravi, here is where it is", "‪Bhai folder 3046 no data joie che‬\nand 3047"))
        assertEquals("Hi", Sender.withQuote("Hi", ""))
        assertEquals("Raw data requirement", Sender.quoteLine("\n\n  Raw data requirement  \n\nNeed raw folder 3046"))
        assertEquals(200, Sender.quoteLine("x".repeat(300)).length)
    }
}
