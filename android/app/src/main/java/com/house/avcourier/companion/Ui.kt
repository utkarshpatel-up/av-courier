package com.house.avcourier.companion

import android.app.Activity
import android.content.Context
import android.graphics.Typeface
import android.text.InputType
import android.text.format.DateUtils
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.graphics.Color
import android.util.TypedValue
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import kotlin.concurrent.thread

// Small helpers for building the screens in code (no layout files).

fun Context.dp(v: Int) = (v * resources.displayMetrics.density).toInt()

fun Context.label(text: CharSequence, size: Float = 15f, bold: Boolean = false, muted: Boolean = false): TextView =
    TextView(this).apply {
        this.text = text
        textSize = size
        if (bold) setTypeface(typeface, Typeface.BOLD)
        if (muted) alpha = 0.65f
        setPadding(0, dp(2), 0, dp(2))
    }

fun Context.button(text: String, outlined: Boolean = false, onClick: () -> Unit): MaterialButton {
    val b = if (outlined) MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle) else MaterialButton(this)
    b.text = text
    b.isAllCaps = false
    b.setOnClickListener { onClick() }
    return b
}

fun Context.vbox(vararg children: View): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    children.forEach { addView(it) }
}

/** A row of buttons that scrolls sideways when it does not fit. */
fun Context.buttons(vararg bs: View): View {
    val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    for (b in bs) {
        row.addView(b, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8) })
    }
    return HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(row) }
}

fun Context.card(vararg children: View, onClick: (() -> Unit)? = null): MaterialCardView {
    val c = MaterialCardView(this)
    c.radius = dp(10).toFloat()
    c.useCompatPadding = true
    val inner = vbox(*children).apply { setPadding(dp(14), dp(10), dp(14), dp(10)) }
    c.addView(inner)
    if (onClick != null) { c.isClickable = true; c.setOnClickListener { onClick() } }
    return c
}

fun ago(t: Long): CharSequence =
    if (t <= 0) "" else DateUtils.getRelativeTimeSpanString(t, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)

fun bytes(n: Double): String {
    val u = listOf("B", "KB", "MB", "GB", "TB")
    var v = n
    var i = 0
    while (v >= 1024 && i < u.size - 1) { v /= 1024; i++ }
    return if (i == 0) "${v.toLong()} B" else String.format("%.1f %s", v, u[i])
}

/**
 * Shows [body] under a blue title bar. Android 15+ draws apps edge to edge, so the
 * screen keeps clear of the status bar, camera cut-out and navigation bar itself.
 */
fun AppCompatActivity.screen(body: View, back: Boolean = false): MaterialToolbar {
    val blue = 0xFF3B82F6.toInt()
    val bar = MaterialToolbar(this).apply {
        setBackgroundColor(blue)
        setTitleTextColor(Color.WHITE)
    }
    val bg = TypedValue().also { theme.resolveAttribute(android.R.attr.colorBackground, it, true) }.data
    body.setBackgroundColor(bg)
    val root = vbox(bar, body).apply { setBackgroundColor(blue) }
    body.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
    setContentView(root)
    setSupportActionBar(bar)
    supportActionBar?.setDisplayHomeAsUpEnabled(back)
    bar.navigationIcon?.setTint(Color.WHITE)
    WindowCompat.getInsetsController(window, root).isAppearanceLightStatusBars = false
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
        val i = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        // The keyboard too, so the buttons under a text box stay reachable while typing.
        val kb = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        v.setPadding(i.left, i.top, i.right, 0)
        body.setPadding(body.paddingLeft, body.paddingTop, body.paddingRight, maxOf(i.bottom, kb))
        insets
    }
    return bar
}

/**
 * The PC link under the title, on every screen: a green dot while connected to the PC,
 * amber while paired but out of reach, grey when not paired. Like the ✓ on the PC.
 */
fun AppCompatActivity.showPcLink(pc: PcLink, paired: Boolean) {
    val (dot, text) = when {
        pc.connected -> 0xFF4ADE80.toInt() to "PC connected"
        paired -> 0xFFFBBF24.toInt() to "PC not reachable"
        else -> 0xFFCBD5E1.toInt() to "Not paired with a PC"
    }
    val s = android.text.SpannableString("● $text")
    s.setSpan(android.text.style.ForegroundColorSpan(dot), 0, 1, 0)
    s.setSpan(android.text.style.StyleSpan(Typeface.BOLD), 0, s.length, 0)
    supportActionBar?.subtitle = s
}

fun Activity.toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

/** Runs [work] off the main thread, then [done] on it with the result or the error text. */
fun <T> Activity.bg(work: () -> T, done: (T?, String?) -> Unit) {
    thread {
        val r = try { Result.success(work()) } catch (e: Exception) { Result.failure(e) }
        runOnUiThread {
            if (isFinishing) return@runOnUiThread
            done(r.getOrNull(), r.exceptionOrNull()?.let { it.message ?: it.toString() })
        }
    }
}

fun Activity.confirm(title: String, message: String, yes: String, onYes: () -> Unit) {
    AlertDialog.Builder(this).setTitle(title).setMessage(message)
        .setPositiveButton(yes) { _, _ -> onYes() }
        .setNegativeButton("Cancel", null).show()
}

/** A text box in a dialog. */
fun Activity.ask(title: String, initial: String, ok: String, multiLine: Boolean = true, hint: String = "", onOk: (String) -> Unit) {
    val box = EditText(this).apply {
        setText(initial)
        this.hint = hint
        inputType = if (multiLine) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES else InputType.TYPE_CLASS_TEXT
        if (multiLine) minLines = 3
    }
    val wrap = vbox(box).apply { setPadding(dp(20), dp(8), dp(20), 0) }
    AlertDialog.Builder(this).setTitle(title).setView(wrap)
        .setPositiveButton(ok) { _, _ -> onOk(box.text.toString()) }
        .setNegativeButton("Cancel", null).show()
}

/** One catalogue row: what it is, when and where, and its backup columns ("—" when empty). */
fun Context.matchCard(c: Catalog, m: Catalog.Match): View {
    val r = m.row
    val where = c.backups(r).joinToString(" · ") { (k, v) -> "$k: ${v.ifEmpty { "—" }}" }.ifEmpty { "no backup columns" }
    return card(
        label(listOf(c.heading(r), r.id).filter { it.isNotEmpty() }.joinToString(" · "), bold = true),
        label(listOf(if (r.folder.isNotEmpty()) "Folder ${r.folder}" else "", r.date, r.place).filter { it.isNotEmpty() }.joinToString(" · "), 13f),
        label(listOf(r.title, if (r.event.isNotEmpty() && r.event != r.title) "(${r.event})" else "").filter { it.isNotEmpty() }.joinToString(" "), 13f),
        label(where, 13f, muted = true),
        label("why: ${m.why.joinToString(" ").ifEmpty { "words" }} · row ${r.rowNo}", 11f, muted = true),
    )
}
