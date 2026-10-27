package com.house.avcourier.companion

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.app.RemoteInput

/**
 * Sends a message from this phone.
 * 1. The chat's notification reply action, if one is stored: sent at once ("phone-reply").
 * 2. Otherwise the chat is opened (wa.me link, or WhatsApp's share screen) with the
 *    text filled in, so you only tap Send ("phone-opened"); when the app is in the
 *    background Android only allows that from a notification ("phone-tap-to-send").
 */
object Sender {
    data class Outcome(val ok: Boolean, val route: String, val error: String? = null)

    private val INVISIBLE = Regex("[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]")

    /** The first line of the message being answered (electron/notifier.js quoteLine). */
    fun quoteLine(s: String?): String =
        (s ?: "").replace(INVISIBLE, "").split('\n').map { it.trim() }.firstOrNull { it.isNotEmpty() }?.take(200) ?: ""

    /**
     * Their words on top in WhatsApp's quote format ("> …", shown with a bar beside it), so
     * the reply is clearly about their message. A notification reply cannot be a real
     * WhatsApp reply-to-message, so the phone always sends it this way.
     */
    fun withQuote(text: String, quote: String?): String {
        val q = quoteLine(quote)
        return if (q.isEmpty()) text else "> $q\n\n$text"
    }

    fun send(
        ctx: Context, channel: String, chat: String, text: String,
        subject: String = "", address: String? = null, pkg: String? = null,
        foreground: Boolean = App.instance.foreground,
    ): Outcome {
        val stored = ReplyActions.get(channel, chat)
        if (stored != null) {
            try {
                val inputs = stored.action.remoteInputs!!
                val results = Bundle()
                for (ri in inputs) results.putCharSequence(ri.resultKey, text)
                val fill = Intent()
                RemoteInput.addResultsToIntent(inputs, fill, results)
                stored.action.actionIntent!!.send(ctx, 0, fill)
                return Outcome(true, "phone-reply")
            } catch (e: Exception) {
                ReplyActions.forget(channel, chat) // the notification is gone: open the chat instead
            }
        }
        val open = openIntent(ctx, channel, chat, text, subject, address, pkg ?: stored?.pkg)
            ?: return Outcome(false, "phone", if (channel == "email") "No email app found" else "WhatsApp is not installed")
        copy(ctx, text)
        if (foreground) {
            try {
                ctx.startActivity(Intent(open).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return Outcome(true, "phone-opened")
            } catch (e: ActivityNotFoundException) {
                // fall through to the notification
            }
        }
        Notifications.tapToSend(ctx, chat, text, Intent(open).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return Outcome(true, "phone-tap-to-send")
    }

    private fun installed(ctx: Context, pkg: String) = ctx.packageManager.getLaunchIntentForPackage(pkg) != null

    fun openIntent(ctx: Context, channel: String, chat: String, text: String, subject: String, address: String?, pkg: String?): Intent? {
        if (channel == "email") {
            val i = if (!address.isNullOrBlank()) {
                Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + Uri.encode(address)))
            } else {
                // Gmail notifications do not carry the address: pick the person in Gmail.
                Intent(Intent.ACTION_SEND).setType("text/plain").apply { if (installed(ctx, NotificationParser.GMAIL)) setPackage(NotificationParser.GMAIL) }
            }
            i.putExtra(Intent.EXTRA_SUBJECT, subject.ifBlank { "Your data request" }).putExtra(Intent.EXTRA_TEXT, text)
            return if (i.resolveActivity(ctx.packageManager) != null) i else null
        }
        val app = listOfNotNull(pkg, "com.whatsapp", "com.whatsapp.w4b").firstOrNull { installed(ctx, it) } ?: return null
        val number = App.instance.prefs.number(ReplyActions.key(channel, chat))
        // With the number the chat opens directly; without it WhatsApp asks which chat.
        val uri = if (number != null) "https://wa.me/$number?text=${Uri.encode(text)}" else "whatsapp://send?text=${Uri.encode(text)}"
        return Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(app)
    }

    private fun copy(ctx: Context, text: String) {
        try {
            ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("AV Courier reply", text))
        } catch (e: Exception) {
            // clipboard not available in the background on some phones
        }
    }
}
