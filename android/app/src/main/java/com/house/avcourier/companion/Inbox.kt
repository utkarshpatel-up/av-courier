package com.house.avcourier.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

/** A message waiting to be handed to the PC. */
class Pending(val externalId: String, val text: String, val at: Long) {
    fun toJson() = JSONObject().put("externalId", externalId).put("text", text).put("at", at)

    companion object {
        fun from(o: JSONObject) = Pending(o.getString("externalId"), o.getString("text"), o.getLong("at"))
    }
}

/** A data request as the phone knows it. */
class LocalRequest(
    val id: String,
    val channel: String,
    val pkg: String,
    val chat: String,
    var sender: String,
    var subject: String,
    var text: String,
    val receivedAt: Long,
    var lastAt: Long,
    var score: Int,
    var status: String, // new, maybe, replied, closed
    var pcId: String?,
    var remindedAt: Long,
    val pending: MutableList<Pending>,
    val history: MutableList<String>,
) {
    val open get() = status == "new"
    val summary get() = text.split('\n')[0].take(140)

    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("channel", channel).put("pkg", pkg).put("chat", chat).put("sender", sender)
        .put("subject", subject).put("text", text).put("receivedAt", receivedAt).put("lastAt", lastAt)
        .put("score", score).put("status", status).put("pcId", pcId ?: JSONObject.NULL).put("remindedAt", remindedAt)
        .put("pending", JSONArray(pending.map { it.toJson() }))
        .put("history", JSONArray(history))

    companion object {
        fun from(o: JSONObject): LocalRequest {
            val pending = o.optJSONArray("pending") ?: JSONArray()
            val history = o.optJSONArray("history") ?: JSONArray()
            return LocalRequest(
                id = o.getString("id"), channel = o.getString("channel"), pkg = o.optString("pkg"),
                chat = o.getString("chat"), sender = o.optString("sender"), subject = o.optString("subject"),
                text = o.optString("text"), receivedAt = o.getLong("receivedAt"), lastAt = o.optLong("lastAt"),
                score = o.optInt("score"), status = o.optString("status", "new"),
                pcId = if (o.isNull("pcId")) null else o.optString("pcId"), remindedAt = o.optLong("remindedAt"),
                pending = MutableList(pending.length()) { Pending.from(pending.getJSONObject(it)) },
                history = MutableList(history.length()) { history.getString(it) },
            )
        }
    }
}

/**
 * The phone's own inbox. Same rules as the PC (electron/main.js incoming()):
 * a WhatsApp message joins an open request from the same chat if it comes
 * within 10 minutes; otherwise it starts a new one when Heuristic says it is a
 * request, or a "maybe" when it scores 15 or more. Small talk is dropped.
 */
class Inbox(ctx: Context) {
    companion object {
        const val GROUP_WINDOW_MS = 10 * 60_000L
        const val MAYBE_SCORE = 15
    }

    class Added(val request: LocalRequest, val announce: Boolean)

    private val file = File(ctx.filesDir, "inbox.json")
    private val items = mutableListOf<LocalRequest>()
    private val seen = LinkedHashSet<String>()
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    init { load() }

    @Synchronized
    fun all(): List<LocalRequest> = items.toList()

    @Synchronized
    fun get(id: String): LocalRequest? = items.find { it.id == id }

    @Synchronized
    fun byPcId(pcId: String): LocalRequest? = items.find { it.pcId == pcId }

    fun listen(l: () -> Unit) = listeners.add(l)
    fun unlisten(l: () -> Unit) = listeners.remove(l)

    @Synchronized
    fun add(m: Caught): Added? {
        if (!seen.add(m.externalId)) return null // WhatsApp repeats unread messages in every notification
        while (seen.size > 2000) seen.remove(seen.first())
        val line = if (m.isGroup && m.sender != m.chat) "${m.sender}: ${m.text}" else m.text

        if (m.channel == "whatsapp") {
            val open = items.find { it.channel == "whatsapp" && it.chat == m.chat && it.status in setOf("new", "maybe") && m.at - it.lastAt < GROUP_WINDOW_MS }
            if (open != null) {
                open.text += "\n" + line
                open.lastAt = m.at
                val h = Heuristic.heuristic(open.text)
                open.score = h.score
                open.pending.add(Pending(m.externalId, m.text, m.at))
                var announce = false
                if (open.status == "maybe" && h.isRequest) { open.status = "new"; announce = true }
                saveLocked()
                return Added(open, announce)
            }
        }

        val text = if (m.channel == "email" && m.subject.isNotBlank() && !m.text.startsWith(m.subject)) "${m.subject}\n${m.text}" else line
        val h = Heuristic.heuristic(text)
        if (!h.isRequest && h.score < MAYBE_SCORE) { saveLocked(); return null }
        val r = LocalRequest(
            id = UUID.randomUUID().toString().take(12), channel = m.channel, pkg = m.pkg, chat = m.chat, sender = m.sender,
            subject = m.subject, text = text, receivedAt = m.at, lastAt = m.at, score = h.score,
            status = if (h.isRequest) "new" else "maybe", pcId = null, remindedAt = 0,
            pending = mutableListOf(Pending(m.externalId, m.text, m.at)),
            history = mutableListOf("Caught on the phone (${m.channel})"),
        )
        items.add(0, r)
        while (items.size > 500) items.removeAt(items.size - 1)
        saveLocked()
        return Added(r, h.isRequest)
    }

    @Synchronized
    fun update(id: String, change: (LocalRequest) -> Unit) {
        val r = items.find { it.id == id } ?: return
        change(r)
        saveLocked()
    }

    @Synchronized
    fun remove(id: String) {
        items.removeAll { it.id == id }
        saveLocked()
    }

    private fun load() {
        try {
            if (!file.exists()) return
            val o = JSONObject(file.readText())
            val arr = o.optJSONArray("items") ?: JSONArray()
            for (i in 0 until arr.length()) items.add(LocalRequest.from(arr.getJSONObject(i)))
            val s = o.optJSONArray("seen") ?: JSONArray()
            for (i in 0 until s.length()) seen.add(s.getString(i))
        } catch (e: Exception) {
            // A damaged file starts a fresh inbox rather than stopping the app.
        }
    }

    private fun saveLocked() {
        val o = JSONObject().put("items", JSONArray(items.map { it.toJson() })).put("seen", JSONArray(seen.toList()))
        val tmp = File(file.path + ".tmp")
        tmp.writeText(o.toString())
        tmp.renameTo(file)
        for (l in listeners) l()
    }
}
