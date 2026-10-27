package com.house.avcourier.companion

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.appcompat.app.AppCompatActivity

/**
 * A request read from a picture: a photo taken or picked on the Find tab, or a picture shared
 * to AV Courier from WhatsApp, Gmail or Gallery. Shows the words read (to correct), then
 * searches the catalogue item by item or keeps it as a request.
 */
class ScanActivity : AppCompatActivity() {
    private val app get() = App.instance
    private lateinit var content: LinearLayout
    private var reading = false
    private var searching = false
    private var results: List<Pair<String, List<Catalog.Match>>>? = null

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
        when {
            kept != null -> { box.setText(kept); who.setText(savedInstanceState.getString("who").orEmpty()) }
            else -> picture(intent)?.let { read(it) } ?: run { toast("No picture to read."); finish(); return }
        }
        render()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        if (!reading) out.putString("text", box.text.toString())
        out.putString("who", who.text.toString())
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
            content.addView(label("Reading the picture…", muted = true))
            return
        }
        val text = box.text.toString()
        val items = Heuristic.items(text)
        content.addView(label(when {
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
        val r = app.inbox.addScanned(name, t)
        app.pc.forwardPending()
        toast("Added to Requests ✓")
        // Into AV Courier's own window, also when the picture was shared from another app.
        startActivity(Intent(this, RequestActivity::class.java).putExtra(RequestActivity.LOCAL, r.id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
    }
}
