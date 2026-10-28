package com.house.avcourier.companion

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.text.InputType
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject

/**
 * A request read from a picture: a photo taken or picked on the Find tab, or a picture shared
 * to AV Courier from WhatsApp, Gmail or Gallery. Shows the words read (to correct), then
 * searches the catalogue item by item or keeps it as a request.
 *
 * A spreadsheet shared to AV Courier comes here too: its rows are read on the phone (Sheet.kt)
 * into the same list. An old .xls or an .ods the phone cannot read goes to the PC as it is.
 */
class ScanActivity : AppCompatActivity() {
    companion object {
        private val PICTURE = Regex("""\.(jpe?g|png|webp|gif|heic)$""", RegexOption.IGNORE_CASE)
    }

    private val app get() = App.instance
    private lateinit var content: LinearLayout
    private var reading = false
    private var searching = false
    private var results: List<Pair<String, List<Catalog.Match>>>? = null
    private var fromSheet: String? = null // the spreadsheet's name, when the words came from one
    private var forPc: Pair<String, ByteArray>? = null // a spreadsheet only the PC can read
    private var sending = false

    private val who by lazy {
        AutoCompleteTextView(this).apply {
            hint = "Who asked: their WhatsApp chat or group name"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            setSingleLine()
            threshold = 1
            // Chats seen before, so the name matches the WhatsApp chat exactly.
            val names = (app.inbox.all().map { it.chat } + app.pc.requests().map { r -> r.optJSONObject("from")?.let { it.str("chat").ifBlank { it.str("name") } }.orEmpty() })
                .filter { it.isNotBlank() }.distinct()
            setAdapter(ArrayAdapter(this@ScanActivity, android.R.layout.simple_dropdown_item_1line, names))
        }
    }
    private val box by lazy {
        EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 4
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        content = vbox().apply { setPadding(dp(14), dp(8), dp(14), dp(32)) }
        screen(ScrollView(this).apply { addView(content) }, back = true)
        title = "Read from a picture"
        val kept = savedInstanceState?.getString("text")
        fromSheet = savedInstanceState?.getString("sheet")
        val u = picture(intent)
        when {
            kept != null -> { box.setText(kept); who.setText(savedInstanceState.getString("who").orEmpty()) }
            u == null -> { toast("Nothing to read."); finish(); return }
            else -> {
                val (name, type) = nameAndType(u)
                when {
                    Sheet.isSheet(name, type) -> readSheet(u, name, type)
                    type == null || type.startsWith("image/") || PICTURE.containsMatchIn(name.orEmpty()) -> read(u)
                    else -> { toast("AV Courier reads pictures and spreadsheets: this is neither."); finish(); return }
                }
            }
        }
        if (fromSheet != null) title = "Read from a spreadsheet"
        render()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        if (!reading && forPc == null) out.putString("text", box.text.toString())
        out.putString("who", who.text.toString())
        fromSheet?.let { out.putString("sheet", it) }
    }

    override fun onSupportNavigateUp(): Boolean { finish(); return true }

    private fun picture(i: Intent?): Uri? {
        if (i == null) return null
        if (i.action == Intent.ACTION_SEND) {
            @Suppress("DEPRECATION")
            return if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else i.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        }
        return i.data
    }

    private fun nameAndType(u: Uri): Pair<String?, String?> {
        val name = try {
            contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        } catch (e: Exception) { null } ?: u.lastPathSegment
        return name to (contentResolver.getType(u) ?: intent.type)
    }

    private fun readSheet(u: Uri, name: String?, type: String?) {
        val n = name ?: "request.xlsx"
        fromSheet = n
        reading = true
        bg({
            val bytes = contentResolver.openInputStream(u)?.use { it.readBytes() } ?: throw IllegalStateException("the file could not be opened")
            if (bytes.size > 10 * 1024 * 1024) throw IllegalStateException("it is larger than 10 MB")
            if (Sheet.readsOnPhone(n, type)) Sheet.read(bytes, n) else { forPc = n to bytes; null }
        }) { r, err ->
            reading = false
            when {
                err != null -> { toast("Could not read the spreadsheet: $err"); finish() }
                forPc != null -> render()
                r == null || r.rows == 0 -> { toast("No rows found in the spreadsheet."); finish() }
                else -> { box.setText(r.text); render() }
            }
        }
    }

    private fun read(u: Uri) {
        reading = true
        bg({ Ocr.read(this, u) }) { text, err ->
            reading = false
            when {
                err != null -> { toast("Could not read the picture: $err"); finish() }
                text.isNullOrBlank() -> { toast("No words found in the picture. Take it straighter and closer, without glare."); finish() }
                else -> { box.setText(text); render() }
            }
        }
    }

    private fun render() {
        content.removeAllViews()
        (who.parent as? android.view.ViewGroup)?.removeView(who)
        (box.parent as? android.view.ViewGroup)?.removeView(box)
        if (reading) {
            content.addView(label(if (fromSheet != null) "Reading the spreadsheet…" else "Reading the picture…", muted = true))
            return
        }
        forPc?.let { (name, _) ->
            content.addView(label(name, 15f, bold = true))
            content.addView(label("The phone cannot read this kind of spreadsheet (old Excel .xls, .xlsb or OpenDocument .ods). The PC can: it is sent there as it is, and the request shows on the PC and here once it is read.", 13f, muted = true))
            content.addView(label("Who asked", 15f, bold = true))
            content.addView(who)
            content.addView(buttons(button(if (sending) "Sending…" else "Send to the PC") { sendToPc() }))
            if (!app.pc.connected) content.addView(label("Not connected to the PC now: connect (same Wi-Fi or ZeroTier), then send. Or save it as .xlsx and share that: the phone reads .xlsx.", 13f, muted = true))
            return
        }
        val text = box.text.toString()
        val items = Heuristic.items(text)
        content.addView(label(when {
            fromSheet != null -> "${items.size} row${if (items.size == 1) "" else "s"} read from $fromSheet. Change any, then search or add it."
            items.size > 1 -> "${items.size} items asked for. Fix any misread words, then search or add it."
            Heuristic.heuristic(text).isRequest -> "Looks like a data request. Fix any misread words, then search or add it."
            else -> "Words read from the picture. Fix any misread words, then search or add it."
        }, 13f, muted = true))
        content.addView(box)
        content.addView(label("To add it as a request", 15f, bold = true))
        content.addView(who)
        content.addView(buttons(
            button(if (searching) "Searching…" else "Search catalogue") { search() },
            button("Add as request", outlined = true) { add() },
        ))
        val c = app.pc.catalog
        val res = results ?: return
        if (c == null) return
        for ((i, pair) in res.withIndex()) {
            val (item, matches) = pair
            if (res.size > 1) content.addView(label("${i + 1}) ${item.take(120)}", 15f, bold = true).apply { setPadding(0, dp(12), 0, dp(2)) })
            if (matches.isEmpty()) content.addView(label("Nothing found in the catalogue.", 13f, muted = true))
            for (m in matches) content.addView(matchCard(c, m))
        }
    }

    private fun search() {
        val c = app.pc.catalog ?: return toast("No catalogue on this phone yet: pair with the PC first.")
        val t = box.text.toString().trim()
        if (t.isEmpty() || searching) return
        searching = true
        render()
        // Each listed item on its own, so one item cannot crowd out another.
        bg({ c.forItems(t, limit = 10) }) { res, err ->
            searching = false
            results = res
            if (err != null) toast(err)
            render()
        }
    }

    private fun add() {
        val t = box.text.toString().trim()
        val name = who.text.toString().trim()
        if (t.isEmpty()) return toast("Nothing to add: the text is empty.")
        if (name.isEmpty()) {
            who.error = "Who asked? Replies go to this WhatsApp chat."
            who.requestFocus()
            return toast("Type who asked first (their WhatsApp chat or group name).")
        }
        val r = app.inbox.addScanned(name, t, if (fromSheet != null) "Read from the spreadsheet $fromSheet on the phone" else "Read from a picture on the phone")
        app.pc.forwardPending()
        toast("Added to Requests ✓")
        // Into AV Courier's own window, also when the picture was shared from another app.
        startActivity(Intent(this, RequestActivity::class.java).putExtra(RequestActivity.LOCAL, r.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }

    private fun sendToPc() {
        val (fileName, bytes) = forPc ?: return
        val name = who.text.toString().trim()
        if (name.isEmpty()) {
            who.error = "Who asked? Replies go to this WhatsApp chat."
            who.requestFocus()
            return toast("Type who asked first (their WhatsApp chat or group name).")
        }
        if (sending) return
        sending = true
        render()
        val at = System.currentTimeMillis()
        val msg = JSONObject().put("channel", "whatsapp").put("externalId", "${Inbox.SCAN}$at")
            .put("from", JSONObject().put("name", name).put("chat", name)).put("text", "").put("receivedAt", at).put("scanned", true)
            .put("files", JSONArray().put(JSONObject().put("name", fileName).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))))
        bg({ app.pc.call("phoneRequest", msg) as? JSONObject }) { res, err ->
            sending = false
            val pcId = res?.str("id").orEmpty()
            when {
                err != null -> { toast(err); render() }
                pcId.isEmpty() -> { toast("The PC could not make a request of it."); render() }
                else -> {
                    toast("Sent to the PC and read there ✓")
                    startActivity(Intent(this, RequestActivity::class.java).putExtra(RequestActivity.PC, pcId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    finish()
                }
            }
        }
    }
}
