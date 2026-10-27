package com.house.avcourier.companion

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

// Mirrors tests/remote.test.js 'verified businesses and ignored senders are never requests'.
class SendersTest {
    private val state = JSONObject().put(
        "ignored",
        JSONObject()
            .put("verified", JSONArray(listOf("Urban Company", "‪ICICI Bank‬")))
            .put("ignored", JSONArray().put(JSONObject().put("key", "whatsapp:dada bhagwan foundation adalaj").put("channel", "whatsapp").put("name", "Dada Bhagwan Foundation Adalaj"))
                .put(JSONObject().put("key", "email:alerts@bank.in").put("channel", "email").put("name", "alerts@bank.in").put("display", "Bank Alerts"))),
    )
    private val lists = Senders.lists(state, JSONArray())

    @Test
    fun verifiedAndIgnoredSendersAreNeverRequests() {
        assertEquals("verified business", Senders.reason("whatsapp", "urban company", lists))
        assertEquals("verified business", Senders.reason("whatsapp", "ICICI Bank", lists))
        assertEquals("ignored sender", Senders.reason("whatsapp", "Dada  Bhagwan Foundation Adalaj", lists))
        assertEquals("", Senders.reason("whatsapp", "Swapnil Patel", lists))
        assertEquals("ignored sender", Senders.reason("email", "Bank Alerts", lists))
        assertEquals("", Senders.reason("email", "Urban Company", lists))
        assertEquals("email:swapnil@gmail.com", Senders.key("email", "Swapnil@Gmail.com"))
    }

    @Test
    fun sendersIgnoredOnThePhoneCountToo() {
        val local = JSONArray().put(JSONObject().put("key", "whatsapp:pfc smart meter survey rdss").put("channel", "whatsapp").put("name", "PFC Smart Meter Survey RDSS"))
        assertEquals("ignored sender", Senders.reason("whatsapp", "PFC Smart Meter Survey RDSS", Senders.lists(state, local)))
    }
}
