package com.house.avcourier.companion

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys

class Prefs(ctx: Context) {
    private val p: SharedPreferences = ctx.getSharedPreferences("avc", Context.MODE_PRIVATE)

    // The PC token is kept encrypted with a key in the Android Keystore.
    private val secure: SharedPreferences? = try {
        EncryptedSharedPreferences.create(
            "avc_secure",
            MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
            ctx,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    } catch (e: Exception) {
        null // no Keystore: the phone cannot be paired
    }

    var token: String?
        get() = secure?.getString("token", null)
        set(v) {
            val e = secure?.edit() ?: return
            if (v == null) e.remove("token") else e.putString("token", v)
            e.apply()
        }

    /** PC addresses from the pairing code, the one that last worked first. */
    var hosts: List<String>
        get() = (p.getString("hosts", "") ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        set(v) = p.edit().putString("hosts", v.distinct().joinToString(",")).apply()

    var port: Int
        get() = p.getInt("port", 8765)
        set(v) = p.edit().putInt("port", v).apply()

    var remindMin: Int
        get() = p.getInt("remindMin", 60)
        set(v) = p.edit().putInt("remindMin", v).apply()

    /** Message templates, refreshed from the PC; the PC's defaults until then. */
    var templatesJson: String?
        get() = p.getString("templates", null)
        set(v) = p.edit().putString("templates", v).apply()

    /** Phone numbers of WhatsApp chats, when the notification gave one away (for wa.me links). */
    fun number(chatKey: String): String? = p.getString("num|$chatKey", null)
    fun setNumber(chatKey: String, n: String) = p.edit().putString("num|$chatKey", n).apply()

    /** Which import of the PC's catalogue this phone holds (its import time). */
    var catalogVersion: Long
        get() = p.getLong("catalogVersion", 0)
        set(v) = p.edit().putLong("catalogVersion", v).apply()

    /** Senders ignored on this phone (JSON array of {key, channel, name, display}), added to the PC's list. */
    var ignoredJson: String
        get() = p.getString("ignored", "[]") ?: "[]"
        set(v) = p.edit().putString("ignored", v).apply()

    val paired get() = token != null && hosts.isNotEmpty()
}
