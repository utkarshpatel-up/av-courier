package com.house.avcourier.companion

import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Reads WhatsApp and Gmail notifications (after you allow it under Notification
 * access). Android keeps this service running, so it also holds the link to the PC.
 * Muted chats raise no notification, so they are never seen here.
 */
class CatchService : NotificationListenerService() {
    companion object {
        fun enabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            val me = ComponentName(ctx, CatchService::class.java)
            return flat.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.any { it == me }
        }
    }

    override fun onListenerConnected() {
        App.instance.pc.start()
        // Messages that arrived while this service was off are still on screen.
        try { activeNotifications?.forEach { onNotificationPosted(it) } } catch (e: SecurityException) { /* not allowed yet */ }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in NotificationParser.PACKAGES) return
        try {
            val messages = NotificationParser.parse(sbn)
            val channel = NotificationParser.channelOf(sbn.packageName)
            // Keep the chat's reply button even for small talk: a reply may be needed later.
            val chat = messages.firstOrNull()?.chat ?: NotificationParser.chatOf(sbn)
            if (chat != null) ReplyActions.remember(sbn, channel, chat)
            for (m in messages) App.instance.caught(m)
        } catch (e: Exception) {
            // One odd notification must not stop the listener.
        }
    }
}
