package com.house.avcourier.companion

import android.app.Notification
import android.os.Build
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat

/** One message read from a WhatsApp or Gmail notification. */
data class Caught(
    val pkg: String,
    val channel: String, // "whatsapp" or "email"
    val chat: String,    // WhatsApp chat (contact or group name) / email sender name
    val sender: String,  // who wrote it (differs from chat in groups)
    val text: String,
    val subject: String,
    val at: Long,
    val externalId: String,
    val isGroup: Boolean,
)

object NotificationParser {
    val WHATSAPP = setOf("com.whatsapp", "com.whatsapp.w4b")
    const val GMAIL = "com.google.android.gm"
    val PACKAGES = WHATSAPP + GMAIL

    fun channelOf(pkg: String) = if (pkg == GMAIL) "email" else "whatsapp"

    // "Family (5 messages)", "Ravi Patel (2 new messages)"
    private val COUNT_SUFFIX = Regex("""\s*\(\d+\s+(new\s+)?messages?\)\s*$""", RegexOption.IGNORE_CASE)
    private val SUMMARY_TITLES = setOf("whatsapp", "whatsapp business", "gmail")

    fun cleanTitle(s: String) = Heuristic.clean(s).replace(COUNT_SUFFIX, "").trim()

    fun parse(sbn: StatusBarNotification): List<Caught> {
        val n = sbn.notification ?: return emptyList()
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return emptyList()
        if (n.category == Notification.CATEGORY_CALL || n.category == "missed_call") return emptyList()
        return when (sbn.packageName) {
            in WHATSAPP -> whatsapp(sbn, n)
            GMAIL -> gmail(sbn, n)
            else -> emptyList()
        }
    }

    /** The chat a notification belongs to, for keeping its reply action. */
    fun chatOf(sbn: StatusBarNotification): String? {
        val n = sbn.notification ?: return null
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        val title = style?.conversationTitle?.toString() ?: n.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return null
        val t = cleanTitle(title)
        return if (t.lowercase() in SUMMARY_TITLES) null else t
    }

    private fun whatsapp(sbn: StatusBarNotification, n: Notification): List<Caught> {
        val ex = n.extras
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return emptyList()
        if (cleanTitle(title).lowercase() in SUMMARY_TITLES) return emptyList() // "5 messages from 3 chats"
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        if (style != null && style.messages.isNotEmpty()) {
            val chat = cleanTitle(style.conversationTitle?.toString() ?: title)
            val me = style.user.name?.toString()
            return style.messages
                // A message without a sender is one you sent yourself.
                .filter { m -> m.person != null && m.person?.name?.toString() != me && !m.text.isNullOrBlank() }
                .map { m ->
                    val text = Heuristic.clean(m.text.toString())
                    Caught(
                        pkg = sbn.packageName, channel = "whatsapp", chat = chat,
                        sender = m.person?.name?.toString()?.let { Heuristic.clean(it) } ?: chat, text = text, subject = "",
                        at = if (m.timestamp > 0) m.timestamp else sbn.postTime,
                        externalId = "${sbn.packageName}|$chat|${m.timestamp}|${text.hashCode()}",
                        isGroup = style.isGroupConversation,
                    )
                }
        }
        // Older layout: title "Group: Sender" or "Name", text the message.
        val text = Heuristic.clean(ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: return emptyList())
        val parts = title.split(": ", limit = 2)
        val chat = cleanTitle(parts[0])
        return listOf(
            Caught(
                pkg = sbn.packageName, channel = "whatsapp", chat = chat, sender = parts.getOrNull(1) ?: chat,
                text = text, subject = "", at = n.`when`.takeIf { it > 0 } ?: sbn.postTime,
                externalId = "${sbn.packageName}|$chat|${n.`when`}|${text.hashCode()}", isGroup = parts.size > 1,
            ),
        )
    }

    private fun gmail(sbn: StatusBarNotification, n: Notification): List<Caught> {
        val ex = n.extras
        val sender = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return emptyList()
        if (sender.lowercase() in SUMMARY_TITLES) return emptyList()
        val subject = ex.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        // Big text is "Subject\nfirst lines of the mail".
        val big = ex.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        if (big == null && ex.getCharSequenceArray(Notification.EXTRA_TEXT_LINES) != null) return emptyList() // "3 new emails"
        val text = big ?: subject
        if (text.isBlank()) return emptyList()
        return listOf(
            Caught(
                pkg = sbn.packageName, channel = "email", chat = sender, sender = sender, text = text,
                subject = subject, at = n.`when`.takeIf { it > 0 } ?: sbn.postTime,
                externalId = "${sbn.packageName}|${sbn.key}|${text.hashCode()}", isGroup = false,
            ),
        )
    }

    /** WhatsApp names its conversation shortcuts after the chat: "919876543210@s.whatsapp.net". */
    fun waNumber(sbn: StatusBarNotification): String? {
        if (sbn.packageName !in WHATSAPP || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        val id = sbn.notification?.shortcutId ?: return null
        return Regex("""^(\d{7,15})@s\.whatsapp\.net$""").find(id)?.groupValues?.get(1)
    }
}
