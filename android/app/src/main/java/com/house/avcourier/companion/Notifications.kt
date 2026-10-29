package com.house.avcourier.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

object Notifications {
    private const val REQUESTS = "requests"
    private const val REMINDERS = "reminders"
    private const val SEND = "send"
    private const val DONE = "done"

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(REQUESTS, "Data requests", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(REMINDERS, "Unanswered requests", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(SEND, "Messages to send", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A reply that needs one tap on Send in WhatsApp"
        })
        nm.createNotificationChannel(NotificationChannel(DONE, "Copies finished", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A copy on the PC finished, and whether the message reached the requester"
        })
    }

    private fun allowed(ctx: Context) = Build.VERSION.SDK_INT < 33 ||
        ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun post(ctx: Context, id: Int, b: NotificationCompat.Builder) {
        if (!allowed(ctx)) return
        try { NotificationManagerCompat.from(ctx).notify(id, b.build()) } catch (e: SecurityException) { /* permission withdrawn */ }
    }

    private fun openApp(ctx: Context, localId: String? = null, code: Int = 0): PendingIntent {
        val i = if (localId != null) Intent(ctx, RequestActivity::class.java).putExtra(RequestActivity.LOCAL, localId)
        else Intent(ctx, MainActivity::class.java)
        i.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun request(ctx: Context, r: LocalRequest) {
        post(ctx, r.id.hashCode(), NotificationCompat.Builder(ctx, REQUESTS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Data request: ${r.chat}")
            .setContentText(r.summary)
            .setStyle(NotificationCompat.BigTextStyle().bigText(r.text.take(600)))
            .setContentIntent(openApp(ctx, r.id, r.id.hashCode()))
            .setAutoCancel(true))
    }

    fun reminder(ctx: Context, due: List<LocalRequest>) {
        val oldestH = (System.currentTimeMillis() - due.minOf { it.receivedAt }) / 3_600_000
        post(ctx, 1, NotificationCompat.Builder(ctx, REMINDERS)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("${due.size} data request${if (due.size > 1) "s" else ""} waiting")
            .setContentText("${due.take(4).joinToString(", ") { it.chat }}. Oldest: $oldestH h")
            .setContentIntent(openApp(ctx))
            .setAutoCancel(true))
    }

    /** From the PC: a copy finished, and whether the message was delivered. */
    fun notice(ctx: Context, title: String, body: String, ok: Boolean) {
        post(ctx, (title + body).hashCode(), NotificationCompat.Builder(ctx, DONE)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(if (ok) title else "⚠ $title")
            .setContentText(body.split('\n').drop(1).firstOrNull() ?: body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(if (ok) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp(ctx, code = 2))
            .setAutoCancel(true))
    }

    /** Android does not let a background app open WhatsApp: this notification does it on a tap. */
    fun tapToSend(ctx: Context, chat: String, text: String, open: Intent) {
        val code = (chat + text).hashCode()
        val pi = PendingIntent.getActivity(ctx, code, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        post(ctx, code, NotificationCompat.Builder(ctx, SEND)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("Tap to send to $chat")
            .setContentText(text.split('\n')[0])
            .setStyle(NotificationCompat.BigTextStyle().bigText("$text\n\nOpens WhatsApp with this filled in: tap Send. (Also copied.)"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pi)
            .setAutoCancel(true))
    }
}
