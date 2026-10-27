package com.house.avcourier.companion

import org.json.JSONArray
import org.json.JSONObject

/**
 * Senders whose messages are never data requests: WhatsApp verified businesses (the PC
 * spots their badge in WhatsApp Web) and senders you chose to ignore. Same matching as
 * electron/senders.js. The lists come from the PC; ones ignored on this phone while the
 * PC was out of reach are kept here too.
 */
object Senders {
    private val INVISIBLE = Regex("[​-‏‪-‮⁦-⁩﻿]")
    private val SPACES = Regex("""\s+""")

    fun norm(s: String?) = (s ?: "").replace(INVISIBLE, "").lowercase().replace(SPACES, " ").trim()

    /** "whatsapp:urban company", "email:alerts@bank.in" (by name when the address is unknown). */
    fun key(channel: String, chatOrAddress: String) = "${if (channel == "email") "email" else "whatsapp"}:${norm(chatOrAddress)}"

    class Ignored(val key: String, val channel: String, val name: String, val display: String)

    class Lists(val verified: List<String>, val ignored: List<Ignored>)

    fun lists(state: JSONObject, local: JSONArray): Lists {
        val o = state.optJSONObject("ignored") ?: JSONObject()
        val v = o.optJSONArray("verified")
        val verified = (0 until (v?.length() ?: 0)).map { v!!.optString(it) }
        val ignored = (o.optJSONArray("ignored").objects() + local.objects()).map { Ignored(it.str("key"), it.str("channel"), it.str("name"), it.str("display")) }
        return Lists(verified, ignored)
    }

    /** "" when the message may be a request. chat: the WhatsApp chat, or the email sender's name. */
    fun reason(channel: String, chat: String, lists: Lists): String {
        val email = channel == "email"
        val k = key(channel, chat)
        if (k.endsWith(":")) return ""
        if (!email && lists.verified.any { "whatsapp:${norm(it)}" == k }) return "verified business"
        if (lists.ignored.any { it.key == k }) return "ignored sender"
        if (email) {
            val n = norm(chat)
            if (lists.ignored.any { it.channel == "email" && (it.key == "email:$n" || norm(it.name) == n || (it.display.isNotEmpty() && norm(it.display) == n)) }) return "ignored sender"
        }
        return ""
    }
}
