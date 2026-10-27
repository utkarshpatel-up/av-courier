package com.house.avcourier.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

class HeuristicTest {
    private fun isRequest(t: String) = Heuristic.heuristic(t).isRequest

    // Mirrors tests/core.test.js 'Gujarati and Hindi requests are recognised'.
    @Test
    fun gujaratiAndHindiRequestsAreRecognised() {
        for (t in listOf("Bhai folder 3034 no data joie che", "Hong kong peak visit no video mokalo ne", "janma jayanti 2012 raw data chahiye")) {
            assertTrue(t, isRequest(t))
        }
        for (t in listOf("Satsang saras hato", "Jai Sachchidanand, kem cho?")) {
            assertFalse(t, isRequest(t))
        }
    }

    // Mirrors tests/core.test.js 'bank, bill and promo messages are not data requests'.
    @Test
    fun bankBillAndPromoMessagesAreNotDataRequests() {
        for (t in listOf(
            "Dear Customer, Premium under your policy was due on 01-Oct-2026. Please note the grace period",
            "Payment for your ICICI Bank card XXXX-4002 is due on October 30, 2026. Bill amount: ₹304.00",
            "Return request for your product has been accepted. Initially delivered item",
            "*Talk as long as you want for free* Stay close with voice and video calls",
            "Satsang saras hato",
            // Polite instructions about recording are not requests for archive data.
            "Darshan will continue at the beginning of Satsang in the afternoon.  Please plan the video setup accordingly.",
            "Kindly check the audio mixer before satsang",
        )) assertFalse(t, isRequest(t))
        for (t in listOf(
            "Prachar mate Raw joie Chhe DD-F-HD-1062-M  CC Udaybhai",
            "‪Please send the Gurupurnima satsang video‬", // WhatsApp's direction marks
            "Vitraag episode 2350 mokalo",
        )) assertTrue(t, isRequest(t))
    }

    // Mirrors tests/core.test.js 'request detection'.
    @Test
    fun requestDetection() {
        assertTrue(isRequest("Bhai please send Janmashtami sabha footage of 16 Aug"))
        assertFalse(isRequest("ok thanks"))
    }

    @Test
    fun requestsScoreAtLeast30AndOthersBelow24() {
        assertEquals(30, Heuristic.heuristic("Hong kong peak visit no video mokalo ne").score)
        assertEquals(23, Heuristic.heuristic("Please share the files").score)
        assertEquals("Please send the Gurupurnima satsang video", Heuristic.heuristic("‪Please send the Gurupurnima satsang video‬").summary)
    }

    // Mirrors tests/core.test.js 'drive and tape numbers match however they are written'.
    @Test
    fun driveAndTapeNumbers() {
        assertTrue(Heuristic.ids("HDD-0123").contains("d:123"))
        assertTrue(Heuristic.ids("drive no 123").contains("d:123"))
        assertTrue(Heuristic.ids("LTO 045").contains("t:45"))
        assertEquals(listOf("2026-08-16"), Heuristic.dates("Dt-16-Aug-26"))
        assertTrue(Heuristic.dates("on 16/08/2026").contains("2026-08-16"))
    }

    @Test
    fun dayAndMonthWithoutYearIsTheMostRecentOne() {
        val now = Calendar.getInstance().apply { clear(); set(2026, Calendar.OCTOBER, 18, 12, 0) }.timeInMillis
        assertEquals(listOf("2026-08-16"), Heuristic.dates("footage of 16 Aug", now = now))
        assertEquals(listOf("2025-12-25"), Heuristic.dates("25 Dec program", now = now))
    }

    // What electron/extract.js heuristic() returns for the same messages:
    // text, score, isRequest, ids, numbers, dates.
    @Test
    fun sameResultsAsTheDesktopApp() {
        data class Row(val text: String, val score: Int, val isRequest: Boolean, val ids: List<String>, val numbers: List<String>, val dates: List<String>)
        val none = listOf<String>()
        val table = listOf(
            Row("Bhai folder 3034 no data joie che", 73, true, none, none, none),
            Row("Hong kong peak visit no video mokalo ne", 30, true, none, none, none),
            Row("janma jayanti 2012 raw data chahiye", 58, true, none, none, none),
            Row("Satsang saras hato", 14, false, none, none, none),
            Row("Jai Sachchidanand, kem cho?", 0, false, none, none, none),
            Row("ok thanks", 0, false, none, none, none),
            Row("Dear Customer, Premium under your policy was due on 01-Oct-2026. Please note the grace period", 0, false, none, none, listOf("2026-10-01")),
            Row("Payment for your ICICI Bank card XXXX-4002 is due on October 30, 2026. Bill amount: ₹304.00", 0, false, none, none, listOf("2026-10-30")),
            Row("Return request for your product has been accepted. Initially delivered item", 0, false, none, none, none),
            Row("*Talk as long as you want for free* Stay close with voice and video calls", 0, false, none, none, none),
            Row("Prachar mate Raw joie Chhe DD-F-HD-1062-M  CC Udaybhai", 86, true, listOf("hd1062"), none, none),
            Row("‪Please send the Gurupurnima satsang video‬", 58, true, none, none, none),
            Row("Vitraag episode 2350 mokalo", 80, true, none, none, none),
            Row("Please send DD-F-4K-3034-E", 58, true, none, none, none),
            Row("drive no 123 ma shu che?", 23, false, listOf("drive123"), listOf("123"), none),
            Row("HDD-0123 and LTO 045 joiye", 100, true, listOf("hdd123", "lto45"), listOf("45"), none),
            Row("Gurupurnima 2019 Chicago ni recording bhejo", 46, true, none, none, none),
            Row("Navratri garba 17 Oct 2026 video aapjo", 40, true, none, none, listOf("2026-10-17")),
            Row("video clips 16/08/2026 chahiye", 54, true, none, none, listOf("2026-08-16")),
            Row("Can you share the audio?", 43, true, none, none, none),
            Row("Aptavani parayan Sep 2026 raw files mokalsho", 66, true, none, none, listOf("2026-09")),
            Row("tape 45 copy kari do", 23, false, listOf("tape45"), listOf("45"), none),
            Row("Please share the files", 23, false, none, none, none),
            Row("Order your copy now https://x.co, offer ends today", 0, false, none, none, none),
            Row("Darshan will continue at the beginning of Satsang in the afternoon.  Please plan the video setup accordingly.", 23, false, none, none, none),
            Row("Kindly check the audio mixer before satsang", 23, false, none, none, none),
            Row("Please, HDD 123", 23, false, listOf("hdd123"), listOf("123"), none),
        )
        for (row in table) {
            val r = Heuristic.heuristic(row.text)
            assertEquals(row.text, row.score, r.score)
            assertEquals(row.text, row.isRequest, r.isRequest)
            assertEquals(row.text, row.ids, r.ids)
            assertEquals(row.text, row.numbers, r.numbers)
            assertEquals(row.text, row.dates, r.dates)
        }
    }
}
