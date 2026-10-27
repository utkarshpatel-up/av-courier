package com.house.avcourier.companion

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Every 15 minutes: reconnect to the PC, hand over requests it has not seen yet,
 * and remind you of requests still unanswered on this phone (the PC reminds you
 * of the ones it holds).
 */
class ReminderWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val app = App.instance
        app.pc.start()
        app.pc.forwardPending()
        val every = app.prefs.remindMin * 60_000L
        val now = System.currentTimeMillis()
        val due = app.inbox.all().filter {
            it.open && (it.pcId == null || !app.pc.connected) && now - it.receivedAt > every && now - it.remindedAt > every
        }
        if (due.isNotEmpty()) {
            for (r in due) app.inbox.update(r.id) { it.remindedAt = now }
            Notifications.reminder(applicationContext, due)
        }
        return Result.success()
    }
}
