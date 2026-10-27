package com.house.avcourier.companion

import android.app.Activity
import android.app.Application
import android.os.Bundle
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class App : Application() {
    companion object {
        lateinit var instance: App
            private set
    }

    val prefs by lazy { Prefs(this) }
    val inbox by lazy { Inbox(this) }
    val pc by lazy { PcLink(this) }

    /** True while one of this app's screens is showing: only then may it open WhatsApp itself. */
    @Volatile
    var foreground = false
        private set
    private var started = 0

    override fun onCreate() {
        super.onCreate()
        instance = this
        Notifications.createChannels(this)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(a: Activity) { started++; foreground = true }
            override fun onActivityStopped(a: Activity) { started--; foreground = started > 0 }
            override fun onActivityCreated(a: Activity, b: Bundle?) {}
            override fun onActivityResumed(a: Activity) {}
            override fun onActivityPaused(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        })
        // Reminders and retries every 15 minutes, even when the app is closed.
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "reminders",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<ReminderWorker>(15, TimeUnit.MINUTES).build(),
        )
        pc.loadCatalog()
        pc.start()
    }

    fun senderLists(): Senders.Lists =
        Senders.lists(pc.state, try { org.json.JSONArray(prefs.ignoredJson) } catch (e: Exception) { org.json.JSONArray() })

    /** A message caught from a notification: into the phone inbox, then on to the PC. */
    fun caught(m: Caught) {
        // Verified businesses and ignored senders: never data requests.
        if (Senders.reason(m.channel, m.chat, senderLists()).isNotEmpty()) return
        val added = inbox.add(m) ?: return
        if (added.announce) Notifications.request(this, added.request)
        pc.forwardPending()
    }
}
