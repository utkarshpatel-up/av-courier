package com.house.avcourier.companion

import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream

/** code 0 = the PC could not be reached. */
class PcError(message: String, val code: Int = 0) : Exception(message)

/** A string field that may be missing or JSON null. */
fun JSONObject.str(key: String): String = if (isNull(key)) "" else optString(key)

fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

/**
 * The link to AV Courier on the PC (electron/remote.js): pairing, calls on its
 * `api`, and the event stream that carries queue progress, new requests and
 * messages the PC wants this phone to send.
 */
class PcLink(private val app: App) {
    companion object {
        // Same as electron/notifier.js TEMPLATES; the PC's own versions replace these once connected.
        val DEFAULT_TEMPLATES = mapOf(
            "copyDone" to "Hi {name}, the data you asked for is ready.\n{job}: {files} files, {size}, copied to {dest} and verified.",
            "located" to "Hi {name}, here is where it is:\n{rows}",
            "notFound" to "Hi {name}, I could not find \"{query}\" in the archive. Can you send the date, place or drive/tape number?",
            "ready" to "Hi {name}, the data you asked for is ready.",
        )
        private val UNREACHABLE = "Could not reach the PC. Is the phone on the same Wi-Fi, and is the phone remote on in AV Courier → Settings?"
    }

    private val prefs get() = app.prefs
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val http = OkHttpClient.Builder().connectTimeout(4, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    // Replies may wait for WhatsApp Web on the PC, then for this phone: give them time.
    private val slow = http.newBuilder().readTimeout(200, TimeUnit.SECONDS).build()
    // The PC pings the stream every 25 s; silence for longer means the link is gone.
    private val stream = http.newBuilder().readTimeout(70, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val listeners = CopyOnWriteArraySet<(String) -> Unit>()
    private val handled = Collections.synchronizedSet(LinkedHashSet<String>())
    private val stateFile = File(app.filesDir, "pc-state.json")

    /** True while the event stream to the PC is open. */
    @Volatile
    var connected = false
        private set

    /** The PC's last known state (kept on disk, so it is there when the PC is off). */
    @Volatile
    var state: JSONObject = loadState()
        private set

    private var source: EventSource? = null
    private var backoff = 2000L
    private var hostIndex = 0
    private var wanted = false

    fun listen(l: (String) -> Unit) { listeners.add(l) }
    fun unlisten(l: (String) -> Unit) { listeners.remove(l) }
    private fun emit(what: String) { main.post { for (l in listeners) l(what) } }

    private fun base(): String {
        val h = prefs.hosts
        return "http://${h[hostIndex % h.size]}:${prefs.port}"
    }

    // ---------------------------------------------------------------- calls (blocking: never on the main thread)
    private fun errorText(body: String, code: Int): String {
        val e = try { JSONObject(body).str("error") } catch (x: JSONException) { "" }
        return e.ifBlank { "The PC answered $code" }
    }

    private fun exec(client: OkHttpClient, path: String, body: JSONObject?): String {
        val token = prefs.token ?: throw PcError("Not paired with a PC")
        if (prefs.hosts.isEmpty()) throw PcError("Not paired with a PC")
        val rb = Request.Builder().url(base() + path).header("Authorization", "Bearer $token")
        if (body != null) rb.post(body.toString().toRequestBody(jsonType)) else rb.get()
        try {
            client.newCall(rb.build()).execute().use { res ->
                val text = res.body?.string() ?: ""
                if (res.code == 401) {
                    onUnpaired()
                    throw PcError("The PC no longer knows this phone: pair it again", 401)
                }
                if (!res.isSuccessful) throw PcError(errorText(text, res.code), res.code)
                return text
            }
        } catch (e: IOException) {
            throw PcError(UNREACHABLE)
        }
    }

    /** Calls a method of the PC's `api` (only those remote.js allows). */
    fun call(method: String, vararg args: Any?): Any? {
        val arr = JSONArray()
        for (a in args) arr.put(a ?: JSONObject.NULL)
        // Replies may wait for WhatsApp Web; drive and tape scans can take minutes.
        val client = if (method in setOf("replyToRequest", "notifyJob", "rescanDrives", "scanTape")) slow else http
        val o = JSONObject(exec(client, "/api/call", JSONObject().put("method", method).put("args", arr)))
        return if (o.isNull("result")) null else o.get("result")
    }

    fun refresh(): JSONObject {
        val s = JSONObject(exec(http, "/api/state", null))
        setState(s)
        return s
    }

    // ---------------------------------------------------------------- pairing
    /** Returns null when paired, otherwise what went wrong. Blocking. */
    fun pair(hosts: List<String>, port: Int, code: String): String? {
        var problem = UNREACHABLE
        for (h in hosts) {
            try {
                val body = JSONObject().put("code", code.trim()).put("name", "${Build.MANUFACTURER} ${Build.MODEL}")
                val req = Request.Builder().url("http://$h:$port/pair").post(body.toString().toRequestBody(jsonType)).build()
                http.newCall(req).execute().use { res ->
                    val text = res.body?.string() ?: ""
                    if (!res.isSuccessful) return errorText(text, res.code)
                    prefs.token = JSONObject(text).getString("token")
                    if (prefs.token == null) return "This phone cannot store the PC key safely (no Android Keystore)."
                    prefs.hosts = listOf(h) + hosts
                    prefs.port = port
                    hostIndex = 0
                    wanted = true
                    restart()
                    return null
                }
            } catch (e: IOException) {
                problem = UNREACHABLE
            } catch (e: JSONException) {
                problem = "Something answered at $h:$port, but it is not AV Courier."
            }
        }
        return problem
    }

    fun unpair() {
        prefs.token = null
        prefs.hosts = emptyList()
        stop()
    }

    private fun onUnpaired() {
        prefs.token = null
        main.post { source?.cancel(); source = null; connected = false }
        emit("unpaired")
    }

    // ---------------------------------------------------------------- event stream
    fun start() {
        wanted = true
        main.post { if (source == null && prefs.paired) connect() }
    }

    fun stop() {
        wanted = false
        main.post { source?.cancel(); source = null; connected = false; emit("link") }
    }

    private fun restart() {
        main.post { source?.cancel(); source = null; connected = false; connect() }
    }

    private fun connect() {
        val token = prefs.token ?: return
        if (prefs.hosts.isEmpty()) return
        val req = Request.Builder().url(base() + "/api/events")
            .header("Authorization", "Bearer $token").header("Accept", "text/event-stream").build()
        source = EventSources.createFactory(stream).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                main.post {
                    if (source !== eventSource) return@post
                    connected = true
                    backoff = 2000L
                    emit("link")
                }
                io.execute {
                    try { refresh() } catch (e: Exception) { /* the stream will bring news */ }
                    forwardPendingNow()
                    syncCatalog()
                }
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                handle(type ?: "message", data)
            }

            override fun onClosed(eventSource: EventSource) = lost(eventSource, null)

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) = lost(eventSource, response?.code)
        })
    }

    private fun lost(es: EventSource, code: Int?) {
        main.post {
            if (source !== es) return@post
            source = null
            connected = false
            emit("link")
            if (code == 401) { onUnpaired(); return@post }
            if (!wanted || !prefs.paired) return@post
            hostIndex++ // try the PC's other address next
            main.postDelayed({ if (source == null && wanted) connect() }, backoff)
            backoff = minOf(backoff * 2, 60_000L)
        }
    }

    private fun handle(type: String, data: String) {
        try {
            when (type) {
                "send" -> io.execute { deliver(JSONObject(data)) }
                "queue", "status" -> {
                    synchronized(this) { state.put(type, JSONObject(data)) }
                    emit(type)
                }
                "requests" -> {
                    synchronized(this) { state.put(type, JSONArray(data)) }
                    saveState()
                    emit(type)
                }
                // The PC's lists of verified businesses and ignored senders changed.
                "ignored" -> {
                    synchronized(this) { state.put("ignored", JSONObject(data)) }
                    saveState()
                    emit(type)
                }
                // A new catalogue was imported on the PC: fetch it for offline search.
                "catalog" -> {
                    synchronized(this) { state.put("catalogVersion", JSONObject(data).optLong("version")) }
                    io.execute { syncCatalog() }
                }
            }
        } catch (e: JSONException) {
            // ignore a damaged event
        }
    }

    /** The PC could not send on WhatsApp Web: send it from this phone and report back. */
    private fun deliver(m: JSONObject) {
        val id = m.str("id")
        if (id.isEmpty() || !handled.add(id)) return
        val to = m.optJSONObject("to") ?: JSONObject()
        val channel = to.str("channel").ifBlank { "whatsapp" }
        val chat = to.str("chat").ifBlank { to.str("name") }
        val out = try {
            // WhatsApp: their words on top, so the reply is clearly about their message.
            val text = if (channel == "whatsapp") Sender.withQuote(m.str("text"), to.str("quote")) else m.str("text")
            Sender.send(app, channel, chat, text, m.str("subject"), to.str("address").ifBlank { null })
        } catch (e: Exception) {
            Sender.Outcome(false, "phone", e.message)
        }
        try {
            exec(http, "/api/sent", JSONObject().put("id", id).put("ok", out.ok).put("route", out.route).put("error", out.error ?: JSONObject.NULL))
        } catch (e: PcError) {
            // the PC times the message out and logs it
        }
    }

    // ---------------------------------------------------------------- requests caught on the phone
    fun forwardPending() { io.execute { forwardPendingNow() } }

    private fun forwardPendingNow() {
        if (!prefs.paired) return
        for (r in app.inbox.all().filter { it.pending.isNotEmpty() }) {
            for (p in r.pending.toList()) {
                val msg = JSONObject().put("channel", r.channel).put("externalId", p.externalId)
                    .put("from", JSONObject().put("name", r.chat).put("chat", r.chat))
                    .put("subject", r.subject).put("text", p.text).put("receivedAt", p.at)
                val res = try {
                    call("phoneRequest", msg) as? JSONObject
                } catch (e: PcError) {
                    if (e.code == 0) return // PC not reachable: try again later
                    null // the PC refused this one: do not send it again
                }
                app.inbox.update(r.id) { x ->
                    x.pending.removeAll { it.externalId == p.externalId }
                    val pcId = res?.str("id").orEmpty()
                    if (pcId.isNotEmpty()) {
                        if (x.pcId == null) x.history.add("Handed to the PC")
                        x.pcId = pcId
                    }
                }
            }
        }
    }

    // ---------------------------------------------------------------- catalogue for offline search
    private val catalogFile = File(app.filesDir, "catalog.ndjson.gz")
    private val catalogClient = http.newBuilder().readTimeout(120, TimeUnit.SECONDS).build()

    /** The PC's catalogue as last downloaded; searched on the phone (Catalog.kt). */
    @Volatile
    var catalog: Catalog? = null
        private set

    @Volatile
    var catalogError = ""
        private set

    /** At start: the copy kept from last time. */
    fun loadCatalog() {
        io.execute {
            try {
                if (catalogFile.exists()) { catalog = readCatalog(catalogFile); emit("catalog") }
            } catch (e: Exception) {
                catalogError = "The saved catalogue could not be read: it is fetched again from the PC"
                prefs.catalogVersion = 0
            }
        }
    }

    private fun readCatalog(f: File) = GZIPInputStream(f.inputStream().buffered()).bufferedReader().use { Catalog.read(it) }

    /** Fetches the catalogue when the PC has a newer one than this phone. */
    private fun syncCatalog() {
        val v = state.optLong("catalogVersion")
        if (v <= 0 || (v == prefs.catalogVersion && catalog != null)) return
        val token = prefs.token ?: return
        emit("catalog-loading")
        try {
            // Asking for gzip ourselves keeps OkHttp from unpacking it: it is stored packed.
            val req = Request.Builder().url(base() + "/api/catalog").header("Authorization", "Bearer $token").header("Accept-Encoding", "gzip").build()
            catalogClient.newCall(req).execute().use { res ->
                if (!res.isSuccessful) throw PcError("The PC answered ${res.code}", res.code)
                val tmp = File(catalogFile.path + ".tmp")
                res.body!!.byteStream().use { input -> tmp.outputStream().use { input.copyTo(it) } }
                val c = readCatalog(tmp) // check it before replacing the old copy
                tmp.renameTo(catalogFile)
                catalog = c
                prefs.catalogVersion = res.header("X-Catalog-Version")?.toLongOrNull() ?: v
                catalogError = ""
            }
        } catch (e: Exception) {
            catalogError = "Catalogue not updated: ${e.message}"
        }
        emit("catalog")
    }

    // ---------------------------------------------------------------- state
    private fun loadState(): JSONObject = try { JSONObject(stateFile.readText()) } catch (e: Exception) { JSONObject() }

    private fun setState(s: JSONObject) {
        synchronized(this) { state = s }
        s.optJSONObject("templates")?.let { prefs.templatesJson = it.toString() }
        saveState()
        emit("state")
    }

    private fun saveState() {
        try { stateFile.writeText(synchronized(this) { state.toString() }) } catch (e: IOException) { /* next time */ }
    }

    fun requests(): List<JSONObject> = state.optJSONArray("requests").objects()
    fun request(pcId: String): JSONObject? = requests().find { it.str("id") == pcId }
    fun queue(): JSONObject? = state.optJSONObject("queue")
    fun drives(): List<JSONObject> = state.optJSONObject("status")?.optJSONObject("drives")?.optJSONArray("drives").objects()
    fun recentDest(): List<String> {
        val a = state.optJSONArray("recentDest") ?: return emptyList()
        return (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() }
    }

    fun template(key: String): String {
        val pc = try { prefs.templatesJson?.let { JSONObject(it).str(key) } } catch (e: JSONException) { null }
        return pc?.takeIf { it.isNotBlank() } ?: DEFAULT_TEMPLATES[key] ?: ""
    }
}

/** electron/notifier.js fill() and firstName(). */
object Templates {
    fun fill(tpl: String, vars: Map<String, String>): String =
        Regex("""\{(\w+)\}""").replace(tpl) { m -> vars[m.groupValues[1]] ?: m.value }

    fun firstName(n: String?): String =
        (n ?: "").replace(Regex("""\s*\(.*\)$"""), "").trim().split(Regex("""\s+""")).firstOrNull()?.takeIf { it.isNotEmpty() } ?: "there"
}
