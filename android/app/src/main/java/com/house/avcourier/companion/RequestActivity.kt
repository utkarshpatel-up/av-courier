package com.house.avcourier.companion

import android.os.Bundle
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject

/** One request: its catalogue matches, replies, and queueing the copy on the PC. */
class RequestActivity : AppCompatActivity() {
    companion object {
        const val LOCAL = "local"
        const val PC = "pc"
    }

    private val app get() = App.instance
    private lateinit var content: LinearLayout
    private var localId: String? = null
    private var pcId: String? = null
    private val checked = mutableSetOf<Int>()

    private val local get() = localId?.let { app.inbox.get(it) }
    private val pcReq get() = pcId?.let { app.pc.request(it) }
    private val onPc: (String) -> Unit = { what -> if (what == "requests" || what == "state" || what == "link") render() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        localId = intent.getStringExtra(LOCAL)
        pcId = intent.getStringExtra(PC) ?: local?.pcId
        if (localId == null) pcId?.let { localId = app.inbox.byPcId(it)?.id }
        content = vbox().apply { setPadding(dp(12), dp(8), dp(12), dp(32)) }
        screen(ScrollView(this).apply { addView(content) }, back = true)
        render()
    }

    override fun onSupportNavigateUp(): Boolean { finish(); return true }

    override fun onStart() { super.onStart(); app.pc.listen(onPc) }
    override fun onStop() { app.pc.unlisten(onPc); super.onStop() }

    // Who and where, from the PC's copy if there is one, else the phone's.
    private val channel get() = pcReq?.str("channel")?.takeIf { it.isNotEmpty() } ?: local?.channel ?: "whatsapp"
    private val from get() = pcReq?.optJSONObject("from") ?: JSONObject()
    private val chat get() = from.str("chat").ifBlank { from.str("name") }.ifBlank { local?.chat ?: "" }
    private val name get() = from.str("name").ifBlank { local?.chat ?: "" }
    private val text get() = pcReq?.str("text")?.ifBlank { null } ?: local?.text ?: ""
    private val summary get() = pcReq?.str("summary")?.ifBlank { null } ?: local?.summary ?: ""
    // The PC's matches when it has the request; otherwise this phone's own catalogue search.
    private val matches: List<JSONObject> get() = pcReq?.optJSONArray("matches").let { if (pcReq != null) it.objects() else localMatches }
    private val localMatches: List<JSONObject> by lazy {
        val c = app.pc.catalog ?: return@lazy emptyList()
        c.forRequest(local?.text ?: "").map { m ->
            val r = m.row
            val backups = c.backups(r)
            JSONObject().put("line", c.line(r)).put("title", r.title).put("id", r.id).put("folder", r.folder)
                .put("kind", r.kind).put("series", r.series).put("episodeNo", r.epNo).put("rawId", r.rawId)
                .put("backups", JSONArray(backups.map { it.first }))
                .put("locations", JSONArray(backups.filter { it.second.isNotEmpty() }.map { JSONObject().put("label", it.first).put("value", it.second) }))
                .put("local", true)
        }
    }
    private val live get() = pcId != null && app.pc.connected

    private fun render() {
        content.removeAllViews()
        if (pcReq == null && local == null) {
            content.addView(label("This request is no longer open.", muted = true))
            return
        }
        title = name
        content.addView(label("$name · $channel · ${ago(pcReq?.optLong("receivedAt") ?: local?.receivedAt ?: 0L)}", 13f, muted = true))
        content.addView(card(label(text)))
        content.addView(label(when {
            pcId == null -> "On this phone only${if (app.prefs.paired) " (not handed to the PC yet)" else ""}."
            live -> "On the PC."
            else -> "PC not reachable: showing what it last sent. Replies go out from this phone."
        }, 13f, muted = true))

        val ms = matches
        if (ms.isNotEmpty()) {
            content.addView(label("In the catalogue", 17f, bold = true))
            ms.forEachIndexed { i, m ->
                val box = CheckBox(this).apply {
                    this.text = "${m.str("line").ifBlank { m.str("title") }}\n${whereText(m)}"
                    isChecked = i in checked
                    setOnCheckedChangeListener { _, on -> if (on) checked.add(i) else checked.remove(i) }
                }
                content.addView(box)
            }
        } else if (pcId != null || app.pc.catalog != null) {
            content.addView(label("No catalogue match. Try the Find tab, or reply “not found”.", muted = true))
        }

        content.addView(label("Reply", 17f, bold = true))
        content.addView(buttons(
            button("Where it is") { whereItIs() },
            button("Data is ready", outlined = true) { compose(Templates.fill(app.pc.template("ready"), mapOf("name" to Templates.firstName(name)))) },
            button("Not found", outlined = true) { notFound() },
            button("Write…", outlined = true) { compose("") },
        ))
        if (live) {
            content.addView(label("Copy", 17f, bold = true))
            content.addView(buttons(button("Copy selected to…") { copySelected() }))
        }
        content.addView(buttons(button("Done — close it", outlined = true) { close() }))
        val history = (local?.history ?: emptyList()) + (pcReq?.optJSONArray("history").objects().map { it.str("text") })
        if (history.isNotEmpty()) content.addView(label(history.takeLast(8).joinToString("\n"), 12f, muted = true))
    }

    // Backup columns, "—" where the recording is not backed up yet.
    private fun backupText(m: JSONObject): String {
        val locs = m.optJSONArray("locations").objects()
        val b = m.optJSONArray("backups")
        val labels = (0 until (b?.length() ?: 0)).map { b!!.optString(it) }.ifEmpty { locs.map { it.str("label") } }
        val trim = Regex("""\s*backup$""", RegexOption.IGNORE_CASE)
        return labels.joinToString(" · ") { l ->
            val v = locs.find { it.str("label") == l }?.str("value").orEmpty()
            "${l.replace(trim, "")}: ${v.ifEmpty { "—" }}"
        }
    }

    private fun whereText(m: JSONObject): String {
        val backups = backupText(m)
        val f = m.optJSONArray("found").objects().firstOrNull()
            ?: return if (m.optBoolean("local")) backups.ifEmpty { "No backup columns" }
            else listOf("Not on a connected drive", backups).filter { it.isNotEmpty() }.joinToString("\n")
        return when {
            f.optBoolean("offline") -> "Tape ${f.str("tape")} · not loaded"
            f.str("tape").isNotEmpty() -> "On tape ${f.str("tape")}"
            else -> "On ${f.str("root").ifBlank { "a connected drive" }}${if (f.optBoolean("exact")) "" else " · check the date"}"
        }
    }

    private fun selected(): List<JSONObject> {
        val ms = matches
        return checked.sorted().mapNotNull { ms.getOrNull(it) }.ifEmpty { ms.take(1) }
    }

    private fun whereItIs() {
        val rows = selected()
        if (rows.isEmpty()) return toast("No catalogue match to send. Write the reply instead.")
        if (live) {
            bg({ app.pc.call("locatedMessage", pcId, JSONArray(rows)) as? String }) { msg, err -> compose(msg ?: localLocated(rows).also { if (err != null) toast(err) }) }
        } else compose(localLocated(rows))
    }

    private fun localLocated(rows: List<JSONObject>) =
        Templates.fill(app.pc.template("located"), mapOf("name" to Templates.firstName(name), "rows" to rows.joinToString("\n") { it.str("line") }))

    private fun notFound() {
        val local = Templates.fill(app.pc.template("notFound"), mapOf("name" to Templates.firstName(name), "query" to summary))
        if (live) bg({ app.pc.call("notFoundMessage", pcId) as? String }) { msg, _ -> compose(msg ?: local) }
        else compose(local)
    }

    private fun compose(initial: String) {
        ask("Reply to $name", initial, "Send") { t -> if (t.isNotBlank()) send(t.trim()) }
    }

    /** Through the PC when it is there (it falls back to this phone by itself), else from this phone. */
    private fun send(t: String) {
        if (live) {
            toast("Sending through the PC…")
            bg({ app.pc.call("replyToRequest", pcId, t) }) { _, err ->
                if (err == null) {
                    localId?.let { id -> app.inbox.update(id) { it.status = "replied"; it.history.add("Replied through the PC") } }
                    toast("Sent ✓")
                    finish()
                } else {
                    confirm("The PC could not send it", "$err\n\nSend it from this phone instead?", "Send from phone") { sendFromPhone(t) }
                }
            }
        } else sendFromPhone(t)
    }

    private fun sendFromPhone(t: String) {
        val out = Sender.send(this, channel, chat, t, pcReq?.str("subject") ?: local?.subject ?: "", from.str("address").ifBlank { null }, local?.pkg, foreground = true)
        if (!out.ok) return toast(out.error ?: "Could not send")
        localId?.let { id -> app.inbox.update(id) { it.status = "replied"; it.history.add("Replied from the phone (${out.route})") } }
        // Tell the PC, when it can hear, so it does not remind you again.
        if (live) bg({ app.pc.call("setRequest", pcId, JSONObject().put("status", "replied")) }) { _, _ -> }
        toast(when (out.route) {
            "phone-reply" -> "Sent from this phone ✓"
            else -> "WhatsApp is open with the text filled in: tap Send."
        })
        if (out.route == "phone-reply") finish()
    }

    private fun copySelected() {
        val rows = checked.sorted().mapNotNull { matches.getOrNull(it) }
        if (rows.isEmpty()) return toast("Tick the recordings to copy first.")
        val sources = JSONArray()
        val offline = mutableSetOf<String>()
        val missing = mutableListOf<String>()
        for (r in rows) {
            val f = r.optJSONArray("found").objects().firstOrNull()
            when {
                f == null -> missing.add(r.str("folder").ifBlank { r.str("id") })
                f.optBoolean("offline") -> offline.add(f.str("tape"))
                else -> sources.put(f.str("session").ifBlank { f.str("path") })
            }
        }
        if (offline.isNotEmpty()) toast("Load tape ${offline.joinToString(", ")} first. When the drive light is steady, use Tape ready on the Queue tab, then copy again.")
        if (missing.isNotEmpty()) toast("Not on a connected drive: ${missing.joinToString(", ")}.")
        if (sources.length() == 0) return
        val first = rows[0]
        val jobName = if (first.str("kind") == "episode") "${first.str("series")} ${first.str("episodeNo")}" else listOf(first.str("id"), first.str("title")).filter { it.isNotBlank() }.joinToString(" ")
        val dests = app.pc.recentDest()
        val pick = { dest: String ->
            if (dest.isNotBlank()) bg({
                val who = app.pc.call("recipientFor", pcId) as? JSONObject
                val job = JSONObject().put("sources", sources).put("dest", dest.trim()).put("name", jobName).put("requestId", pcId)
                    .put("notify", if (who != null) JSONArray().put(who) else JSONArray())
                app.pc.call("addJob", job)
            }) { _, err -> toast(err ?: "Added to the queue on the PC ✓") }
        }
        val choices = (dests + "Other folder…").toTypedArray()
        AlertDialog.Builder(this).setTitle("Copy ${sources.length()} item(s) to")
            .setItems(choices) { _, i ->
                if (i < dests.size) pick(dests[i]) else ask("Folder on the PC", dests.firstOrNull() ?: "", "Copy", multiLine = false, hint = "E:\\Requests\\Name") { pick(it) }
            }.show()
    }

    private fun close() {
        localId?.let { id -> app.inbox.update(id) { it.status = "closed" } }
        if (live) bg({ app.pc.call("setRequest", pcId, JSONObject().put("status", "closed")) }) { _, err -> if (err != null) toast(err) }
        finish()
    }
}
