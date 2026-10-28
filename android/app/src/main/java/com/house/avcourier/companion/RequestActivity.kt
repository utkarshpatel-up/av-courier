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
    private var tab: String? = null // "checklist" | "matches"; unset: the checklist when there is one

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
                .put("event", r.event).put("date", r.date).put("place", r.place).put("seriesLabel", r.seriesLabel)
                .put("why", JSONArray(m.why)).put("row", r.rowNo)
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

        // The checklist and the matches as tabs, so the list is not lost under the matches.
        val ms = matches
        val cl = pcReq?.optJSONObject("checklist")
        val items = cl?.optJSONArray("items").objects()
        val showing = tab ?: if (items.isNotEmpty()) "checklist" else "matches"
        val count = when {
            cl == null -> ""
            cl.str("state") == "draft" -> " (draft · ${items.size})"
            else -> " (${items.count { it.str("status") == "done" }} of ${items.size} done)"
        }
        content.addView(buttons(
            button("Checklist$count", outlined = showing != "checklist") { tab = "checklist"; render() },
            button("Matches (${ms.size})", outlined = showing != "matches") { tab = "matches"; render() },
        ))
        if (showing == "checklist") checklist()
        else {
            if (ms.isNotEmpty()) {
                content.addView(label("In the catalogue", 17f, bold = true))
                ms.forEachIndexed { i, m -> content.addView(matchCard(i, m)) }
            } else if (pcId != null || app.pc.catalog != null) {
                content.addView(label("No catalogue match. Try the Find tab, or reply “not found”.", muted = true))
            }
            if (live && ms.isNotEmpty()) content.addView(buttons(button("Copy selected to…", outlined = true) { copySelected() }))
        }

        content.addView(label("Reply", 17f, bold = true))
        content.addView(buttons(
            button("Where it is") { whereItIs() },
            button("Data is ready", outlined = true) { compose(Templates.fill(app.pc.template("ready"), mapOf("name" to Templates.firstName(name)))) },
            button("Not found", outlined = true) { notFound() },
            button("Write…", outlined = true) { compose("") },
        ))
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

    /**
     * One match as on the Find tab: what it is, when and where, its backup columns and, from
     * the PC, whether it is on a connected drive. Tick it (or tap the card) to copy or reply.
     */
    private fun matchCard(i: Int, m: JSONObject): android.view.View {
        val heading = if (m.str("kind") == "episode") "Episode · ${m.str("series")} ${m.str("episodeNo")}".trim() else m.str("seriesLabel")
        val box = CheckBox(this).apply {
            text = listOf(heading, m.str("id")).filter { it.isNotEmpty() }.joinToString(" · ").ifEmpty { m.str("title") }
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            isChecked = i in checked
            setOnCheckedChangeListener { _, on -> if (on) checked.add(i) else checked.remove(i) }
        }
        val title = m.str("title")
        val what = listOf(title, m.str("event").takeIf { it.isNotEmpty() && it != title }?.let { "($it)" }.orEmpty()).filter { it.isNotEmpty() }.joinToString(" ")
        val why = m.optJSONArray("why")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
        val views = listOfNotNull(
            box,
            label(listOf(if (m.str("folder").isNotEmpty()) "Folder ${m.str("folder")}" else "", m.str("date"), m.str("place")).filter { it.isNotEmpty() }.joinToString(" · "), 13f),
            what.takeIf { it.isNotEmpty() }?.let { label(it, 13f) },
            label(backupText(m).ifEmpty { "No backup columns" }, 13f, muted = true),
            diskText(m)?.let { label(it, 13f, bold = true) },
            label("why: ${why.joinToString(" ").ifEmpty { "words" }}${if (m.optInt("row") > 0) " · row ${m.optInt("row")}" else ""}", 11f, muted = true),
        )
        return card(*views.toTypedArray()) { box.isChecked = !box.isChecked }
    }

    /** From the PC: is it on a drive or tape it can see? (The phone itself cannot tell.) */
    private fun diskText(m: JSONObject): String? {
        if (m.optBoolean("local")) return null
        val f = m.optJSONArray("found").objects().firstOrNull() ?: return "Not on a connected drive"
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
        // WhatsApp: their words on top, so the reply is clearly about their message (email keeps the thread).
        val body = if (channel == "whatsapp") Sender.withQuote(t, pcReq?.str("text")?.ifBlank { null } ?: local?.text) else t
        val out = Sender.send(this, channel, chat, body, pcReq?.str("subject") ?: local?.subject ?: "", from.str("address").ifBlank { null }, local?.pkg, foreground = true)
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

    // ---------------------------------------------------------------- checklist
    // The request item by item, with the drive each is on (electron/main.js draftChecklist): a draft
    // until approved, then one copy per item, ticked off as each finishes, and one message at the end.
    // Kept on the PC: every change here is a call to it.

    private val icons = mapOf("copying" to "⏳", "waiting" to "⚠", "failed" to "✗", "todo" to "☐", "done" to "✓", "unavailable" to "—")

    private fun checklist() {
        if (pcId == null) {
            content.addView(label("Made on the PC: it shows here once the request has reached the PC.", 13f, muted = true))
            return
        }
        val c = pcReq?.optJSONObject("checklist")
        if (c == null) {
            if (live) content.addView(buttons(button("Make it from the message", outlined = true) { act("draftChecklist", pcId) }))
            else content.addView(label("None yet. Connect to the PC to make one.", 13f, muted = true))
            return
        }
        val draft = c.str("state") == "draft"
        val items = c.optJSONArray("items").objects()
        val done = items.count { it.str("status") == "done" }
        val sent = c.optLong("sentAt")
        content.addView(label(when {
            draft -> "Draft: check it, then approve. Nothing is copied until then."
            sent > 0 -> "$done of ${items.size} done · told ${ago(sent)}"
            else -> "$done of ${items.size} done${if (c.optBoolean("autoSend")) " · the message goes when all are done" else ""}"
        }, 13f, muted = true))
        if (items.isEmpty()) content.addView(label("Empty: add items below.", 13f, muted = true))
        for (i in items) content.addView(itemCard(i, draft))
        if (!live) {
            content.addView(label("PC not reachable: connect to it to change the list.", 13f, muted = true))
            return
        }
        content.addView(buttons(
            button("+ To-do", outlined = true) { ask("A to-do (for you, not in the message)", "", "Add", multiLine = false) { t -> if (t.isNotBlank()) act("addChecklistItem", pcId, JSONObject().put("title", t.trim())) } },
            button("+ Ticked matches", outlined = true) { addTicked() },
            button("+ Folder on the PC", outlined = true) { addFolder() },
        ))
        if (draft) {
            val dest = c.str("dest")
            content.addView(label("Copy everything to: ${dest.ifBlank { "(choose a folder)" }}", 13f))
            val auto = CheckBox(this).apply {
                text = "When every item is done, tell $name automatically"
                isChecked = c.optBoolean("autoSend")
                setOnCheckedChangeListener { _, on -> act("setChecklist", pcId, JSONObject().put("autoSend", on)) }
            }
            content.addView(auto)
            val copies = items.count { it.str("kind") == "copy" }
            content.addView(buttons(
                button("Approve · start $copies cop${if (copies == 1) "y" else "ies"}") {
                    if (dest.isBlank()) toast("Choose the folder to copy to first.")
                    else act("approveChecklist", pcId, ok = "Approved: copies are in the queue on the PC ✓")
                },
                button("Change folder", outlined = true) { pickDest { d -> act("setChecklist", pcId, JSONObject().put("dest", d)) } },
                button("Make again", outlined = true) { confirm("Make the list again?", "It is made again from the message; changes to it are lost.", "Make again") { act("draftChecklist", pcId) } },
            ))
        } else {
            content.addView(buttons(button(if (done == items.size) "Send the message…" else "Complete and send…") { complete() }))
        }
    }

    private fun itemCard(i: JSONObject, draft: Boolean): android.view.View {
        val id = i.str("id")
        val status = i.str("status")
        val todo = i.str("kind") == "todo"
        val asked = i.str("ask")
        val sources = i.optJSONArray("sources")?.length() ?: 0
        val where = when {
            todo -> if (draft) "To-do" else ""
            sources > 0 -> "From ${i.str("where").ifBlank { "a folder on the PC" }}"
            draft || status == "waiting" -> "Nothing to copy from yet"
            else -> ""
        }
        val views = mutableListOf<android.view.View>(
            label("${if (draft) (if (todo) "☐" else "⧉") else icons[status] ?: ""}  ${i.str("title")}", 15f, bold = true),
        )
        if (asked.isNotBlank() && asked != i.str("title")) views.add(label("Asked: $asked", 13f, muted = true))
        listOf(where, i.str("backups"), i.str("note")).filter { it.isNotBlank() }.takeIf { it.isNotEmpty() }?.let { views.add(label(it.joinToString(" · "), 13f)) }
        if (live) {
            val acts = mutableListOf<android.view.View>()
            val cands = i.optJSONArray("candidates")
            if (draft) {
                if ((cands?.length() ?: 0) > 1) acts.add(button("Other match", outlined = true) {
                    val titles = (0 until cands!!.length()).map { cands.optString(it) }
                    AlertDialog.Builder(this).setTitle("Which recording?").setItems(titles.toTypedArray()) { _, k -> act("pickCandidate", pcId, id, k) }.show()
                })
                acts.add(button("Remove", outlined = true) { act("checklistItem", pcId, id, "remove") })
            } else when (status) {
                "copying" -> views.add(label("In the queue on the PC", 12f, muted = true))
                "done", "unavailable" -> acts.add(button("Undo", outlined = true) { act("checklistItem", pcId, id, "reopen") })
                else -> {
                    acts.add(if (todo) button("Done") { act("checklistItem", pcId, id, "done") } else button("Copy again") { act("checklistItem", pcId, id, "copy") })
                    acts.add(button("Can’t do…", outlined = true) {
                        ask("Why can’t it be done?", "", "Save", hint = "Goes in the message, e.g. “drive 112 is damaged”") { why -> act("checklistItem", pcId, id, "unavailable", why.trim()) }
                    })
                }
            }
            if (acts.isNotEmpty()) views.add(buttons(*acts.toTypedArray()))
        }
        return card(*views.toTypedArray())
    }

    /** A call to the PC's checklist, then the list as the PC now has it. */
    private fun act(method: String, vararg args: Any?, ok: String? = null) {
        bg({ app.pc.call(method, *args); app.pc.refresh() }) { _, err ->
            if (err != null) toast(err) else ok?.let { toast(it) }
            render()
        }
    }

    private fun addTicked() {
        val rows = checked.sorted().mapNotNull { matches.getOrNull(it) }.filter { !it.optBoolean("local") }
        if (rows.isEmpty()) return toast("Tick matches above first.")
        bg({ for (r in rows) app.pc.call("addChecklistItem", pcId, JSONObject().put("row", r)); app.pc.refresh() }) { _, err ->
            toast(err ?: "Added ${rows.size} to the checklist ✓")
            checked.clear()
            render()
        }
    }

    private fun addFolder() {
        ask("Folder on the PC to copy", "", "Add", multiLine = false, hint = "E:\\3034 Dt-15 Sep 2026") { path ->
            val p = path.trim()
            if (p.isNotEmpty()) act("addChecklistItem", pcId, JSONObject().put("sources", JSONArray().put(p)))
        }
    }

    private fun pickDest(then: (String) -> Unit) {
        val dests = app.pc.recentDest()
        val choices = (dests + "Other folder…").toTypedArray()
        AlertDialog.Builder(this).setTitle("Copy everything to")
            .setItems(choices) { _, i ->
                if (i < dests.size) then(dests[i]) else ask("Folder on the PC", dests.firstOrNull() ?: "", "OK", multiLine = false, hint = "E:\\Requests\\Name") { d -> if (d.isNotBlank()) then(d.trim()) }
            }.show()
    }

    private fun complete() {
        bg({ app.pc.call("checklistMessage", pcId) as? String }) { msg, err ->
            if (msg == null) return@bg toast(err ?: "Could not make the message")
            ask("Message to $name", msg, "Send") { t ->
                if (t.isNotBlank()) act("completeRequest", pcId, t.trim(), ok = "Sent ✓")
            }
        }
    }

    private fun close() {
        localId?.let { id -> app.inbox.update(id) { it.status = "closed" } }
        if (live) bg({ app.pc.call("setRequest", pcId, JSONObject().put("status", "closed")) }) { _, err -> if (err != null) toast(err) }
        finish()
    }
}
