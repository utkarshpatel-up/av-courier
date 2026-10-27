package com.house.avcourier.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors tests/core.test.js: lists of recordings split into items; Gujarati asking words. */
class ItemsTest {
    private val alpa = listOf(
        "Jsca,",
        "પાયલબેન સાથે વાત થયા પ્રમાણે અમને નીચેના બે સત્સંગના original parts જોઈએ છે.",
        "",
        "1) Recent Satsang - Night Satsang 20 August 2026 _ Gujarati _ Pujyashree Deepakbhai - Bipinbhai Gutka - 35:00 to",
        "39:00",
        "2) General - Part 098 - Sevarthi Shibir Udaipur 2012 - DD - Sevarthi Episode -",
        "098",
        "",
        "આ parts તમે dbffs24 Share01 આ path પર મૂકી દેશો ?",
    ).joinToString("\n")

    @Test fun numberedListSplitsIntoItems() {
        assertEquals(
            listOf(
                "Recent Satsang - Night Satsang 20 August 2026 _ Gujarati _ Pujyashree Deepakbhai - Bipinbhai Gutka - 35:00 to 39:00",
                "General - Part 098 - Sevarthi Shibir Udaipur 2012 - DD - Sevarthi Episode - 098",
            ),
            Heuristic.items(alpa),
        )
        assertEquals(listOf("need folder 3046\nfrom hdd 12"), Heuristic.items("need folder 3046\nfrom hdd 12"))
        assertEquals(listOf("DD Vitraag 2350", "master 418"), Heuristic.items("• DD Vitraag 2350\n• master 418"))
    }

    @Test fun gujaratiAskingWordsMakeARequest() {
        assertTrue(Heuristic.heuristic(alpa).isRequest)
        assertTrue(Heuristic.heuristic("અમને આ સત્સંગ મોકલજો").isRequest)
        assertFalse(Heuristic.heuristic("સત્સંગ સરસ હતો").isRequest)
    }
}
