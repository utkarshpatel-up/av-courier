package com.house.avcourier.companion

import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import java.util.concurrent.ConcurrentHashMap

/**
 * The "Reply" button of the latest notification from each chat. Filling it in
 * sends a message from the phone's own WhatsApp without opening it.
 * These live in memory only (Android cannot store them), so after the phone
 * restarts a chat needs a new message before it can be answered this way;
 * until then replies open the chat with the text filled in.
 */
object ReplyActions {
    class Stored(val action: NotificationCompat.Action, val pkg: String, val at: Long)

    private val actions = ConcurrentHashMap<String, Stored>()

    fun key(channel: String, chat: String) = "$channel|${chat.trim().lowercase()}"

    fun remember(sbn: StatusBarNotification, channel: String, chat: String) {
        val n = sbn.notification ?: return
        val k = key(channel, chat)
        NotificationParser.waNumber(sbn)?.let { App.instance.prefs.setNumber(k, it) }
        val candidates = mutableListOf<NotificationCompat.Action>()
        for (i in 0 until NotificationCompat.getActionCount(n)) NotificationCompat.getAction(n, i)?.let { candidates.add(it) }
        candidates.addAll(NotificationCompat.WearableExtender(n).actions)
        val reply = candidates.firstOrNull { a -> a.actionIntent != null && a.remoteInputs?.any { it.allowFreeFormInput } == true }
            ?: return
        actions[k] = Stored(reply, sbn.packageName, System.currentTimeMillis())
    }

    fun get(channel: String, chat: String): Stored? = actions[key(channel, chat)]

    fun forget(channel: String, chat: String) {
        actions.remove(key(channel, chat))
    }

    /** Which WhatsApp (normal or Business) a chat was last seen in. */
    fun packageFor(channel: String, chat: String): String? = actions[key(channel, chat)]?.pkg
}
