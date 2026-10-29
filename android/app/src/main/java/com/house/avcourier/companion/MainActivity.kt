package com.house.avcourier.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.google.android.material.tabs.TabLayout
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private val app get() = App.instance
    private lateinit var content: LinearLayout
    private lateinit var tabs: TabLayout
    private var tab = 0

    private val onPc: (String) -> Unit = { what ->
        if (what == "catalog-loading" && tab == 1) toast("Fetching the catalogue from the PC…")
        if (what == "unpaired") toast("The PC unpaired this phone. Pair it again from the PC tab.")
        showPcLink(app.pc, app.prefs.paired)
        render()
    }
    private val onInbox: () -> Unit = { runOnUiThread { render() } }

    private val scan = registerForActivityResult(ScanContract()) { r -> r.contents?.let { pairFrom(Uri.parse(it)) } }
    private val askNotify = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { render() }

    // Scan: a photo (of a monitor, a poster, a list) or a picture already on the phone.
    private var photoUri: Uri? = null
    private val takePhoto = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) photoUri?.let { scanUri(it) } }
    private val pickImage = registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { u -> u?.let { scanUri(it) } }
    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok -> if (ok) openCamera() else toast("Camera not allowed: pick a picture instead.") }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tab = savedInstanceState?.getInt("tab") ?: 0
        tabs = TabLayout(this).apply {
            for (t in listOf("Requests", "Find", "Queue", "PC")) addTab(newTab().setText(t))
            getTabAt(tab)?.select()
            addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
                override fun onTabSelected(t: TabLayout.Tab) { tab = t.position; render() }
                override fun onTabUnselected(t: TabLayout.Tab) {}
                override fun onTabReselected(t: TabLayout.Tab) { refresh() }
            })
        }
        content = vbox().apply { setPadding(dp(10), dp(6), dp(10), dp(24)) }
        val scroll = ScrollView(this).apply { addView(content) }
        val bar = screen(vbox(tabs, scroll).apply {
            scroll.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        })
        // A tap on the title bar (with the PC link under it) opens the PC tab.
        bar.setOnClickListener { tabs.getTabAt(3)?.select() }
        showPcLink(app.pc, app.prefs.paired)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(i: Intent?) {
        val u = i?.data ?: return
        if (u.scheme == "avcourier" && u.host == "pair") pairFrom(u)
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        out.putInt("tab", tab)
    }

    override fun onStart() {
        super.onStart()
        app.pc.listen(onPc)
        app.inbox.listen(onInbox)
        app.pc.start()
        showPcLink(app.pc, app.prefs.paired)
        refresh()
    }

    override fun onStop() {
        app.pc.unlisten(onPc)
        app.inbox.unlisten(onInbox)
        super.onStop()
    }

    private fun refresh() {
        if (!app.prefs.paired) return render()
        bg({ app.pc.refresh() }) { _, _ -> render() }
    }

    private fun render() {
        if (!::content.isInitialized) return
        content.removeAllViews()
        when (tab) {
            0 -> renderRequests()
            1 -> renderFind()
            2 -> renderQueue()
            else -> renderPc()
        }
    }

    private fun linkLine() = label(
        when {
            !app.prefs.paired -> "Not paired with the PC: requests stay on this phone."
            app.pc.connected -> "Connected to the PC."
            else -> "PC not reachable: showing what it last sent. Replies go out from this phone."
        },
        13f, muted = true,
    )

    // ---------------------------------------------------------------- requests
    // Open / Maybe / In progress / Done / All, as on the PC.
    private var reqTab = "open"
    private val cats = listOf("open" to "Open", "maybe" to "Maybe", "progress" to "In progress", "done" to "Done", "all" to "All")
    private fun catOf(status: String) = when (status) {
        "new", "attention" -> "open"; "maybe" -> "maybe"; "copying", "ready" -> "progress"; "replied", "delivered", "closed" -> "done"; else -> "other"
    }
    private fun inTab(status: String) = reqTab == "all" || catOf(status) == reqTab

    private fun renderRequests() {
        if (!CatchService.enabled(this)) {
            content.addView(card(
                label("Allow notification access", 16f, bold = true),
                label("AV Courier reads WhatsApp and Gmail notifications to catch data requests. Nothing is read until you allow it."),
                button("Open notification access") { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) },
            ))
        }
        content.addView(linkLine())

        val allPc = if (app.prefs.paired) app.pc.requests() else emptyList()
        // The phone's own requests, unless the PC has the same one.
        val allLocal = app.inbox.all().filter { it.pcId == null || app.pc.request(it.pcId!!) == null }
        val count = { cat: String -> allPc.count { cat == "all" || catOf(it.str("status")) == cat } + allLocal.count { cat == "all" || catOf(it.status) == cat } }
        content.addView(buttons(*cats.map { (k, name) ->
            val n = count(k)
            button(if (n > 0 && k != "all") "$name ($n)" else name, outlined = k != reqTab) { reqTab = k; ticked.clear(); render() }
        }.toTypedArray()))

        if (ticked.isNotEmpty()) {
            content.addView(card(
                label("${ticked.size} ticked", bold = true),
                buttons(
                    button("Not a request") { dismissTicked() },
                    button("Not a request · ignore sender${if (ticked.size > 1) "s" else ""}") { ignoreTicked() },
                    button("Clear", outlined = true) { ticked.clear(); render() },
                ),
            ))
        }

        val pcReqs = allPc.filter { inTab(it.str("status")) }
        if (pcReqs.isNotEmpty()) {
            content.addView(label("On the PC", 17f, bold = true))
            for (r in pcReqs) {
                val from = r.optJSONObject("from") ?: JSONObject()
                val n = r.optJSONArray("matches")?.length() ?: 0
                val status = r.str("status")
                val meta = "${from.str("name")} · ${r.str("channel")} · ${ago(r.optLong("receivedAt"))}"
                content.addView(card(
                    if (status == "dismissed") label(meta, 13f, muted = true) else tickRow("pc:${r.str("id")}", meta),
                    label(r.str("summary").ifBlank { r.str("text") }.take(200), bold = status == "new"),
                    label("${statusText(status)}${if (n > 0) " · $n match${if (n > 1) "es" else ""} in the catalogue" else " · no catalogue match"}", 13f, muted = true),
                ) { open(pcId = r.str("id")) })
            }
        }

        val local = allLocal.filter { inTab(it.status) }
        if (local.isNotEmpty()) {
            content.addView(label(if (app.prefs.paired) "Caught on this phone, not on the PC" else "Caught on this phone", 17f, bold = true))
            for (r in local) {
                val meta = "${r.chat} · ${r.channel} · ${ago(r.receivedAt)}"
                content.addView(card(
                    if (r.status == "dismissed") label(meta, 13f, muted = true) else tickRow("local:${r.id}", meta),
                    label(r.summary, bold = r.status == "new"),
                    label(when {
                        r.status == "maybe" -> "Maybe a request"
                        r.status != "new" -> statusText(r.status)
                        r.pending.isNotEmpty() -> "Waiting to reach the PC"
                        else -> "New"
                    }, 13f, muted = true),
                ) { open(localId = r.id) })
            }
        }
        if (pcReqs.isEmpty() && local.isEmpty()) content.addView(label("Nothing here.", muted = true))
    }

    // ---------------------------------------------------------------- false alarms, several at once
    private val ticked = LinkedHashSet<String>() // "pc:<id>" or "local:<id>"

    private fun tickRow(key: String, text: String): android.view.View {
        val box = android.widget.CheckBox(this).apply {
            isChecked = key in ticked
            setOnCheckedChangeListener { _, on -> if (on) ticked.add(key) else ticked.remove(key); render() }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            addView(box)
            addView(label(text, 13f, muted = true), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        }
    }

    /** Ticked requests become "not a request": on the PC (and its other computers) and on this phone. */
    private fun dismissTicked() {
        val pcIds = ticked.filter { it.startsWith("pc:") }.map { it.removePrefix("pc:") }
        val localIds = ticked.filter { it.startsWith("local:") }.map { it.removePrefix("local:") } +
            pcIds.mapNotNull { app.inbox.byPcId(it)?.id } // the phone's own copy of a PC request
        for (id in localIds.distinct()) app.inbox.update(id) { it.status = "dismissed"; it.history.add("Marked not a request") }
        val count = ticked.size
        ticked.clear()
        if (pcIds.isEmpty()) { toast("$count marked as not a request"); render(); return }
        if (!app.pc.connected) {
            toast("Marked on this phone. Connect to the PC to mark the ${pcIds.size} on the PC as well.")
            render()
            return
        }
        bg({ app.pc.call("dismissRequests", org.json.JSONArray(pcIds)) }) { _, err ->
            toast(err ?: "$count marked as not a request")
            refresh()
        }
    }

    /** Not a request, and nothing from these senders will be from now on (here, on the PC and its other computers). */
    private fun ignoreTicked() {
        val pcIds = ticked.filter { it.startsWith("pc:") }.map { it.removePrefix("pc:") }
        val localIds = ticked.filter { it.startsWith("local:") }.map { it.removePrefix("local:") }
        // key -> channel, the name the sender is known by, and an email sender's display name
        val senders = LinkedHashMap<String, Triple<String, String, String>>()
        for (id in pcIds) {
            val r = app.pc.request(id) ?: continue
            val f = r.optJSONObject("from") ?: JSONObject()
            val email = r.str("channel") == "email"
            val name = if (email) f.str("address").ifEmpty { f.str("name") } else f.str("chat").ifEmpty { f.str("name") }
            senders[Senders.key(r.str("channel"), name)] = Triple(if (email) "email" else "whatsapp", name, if (email) f.str("name") else "")
        }
        for (id in localIds) {
            val r = app.inbox.get(id) ?: continue
            senders[Senders.key(r.channel, r.chat)] = Triple(r.channel, r.chat, if (r.channel == "email") r.chat else "")
        }
        if (senders.isEmpty()) return
        val names = senders.values.joinToString("\n") { it.second }
        confirm("Ignore these senders?", "Messages from these will never be treated as requests:\n\n$names\n\nUndo on the PC: Settings → Never a request.", "Ignore") {
            val list = try { org.json.JSONArray(app.prefs.ignoredJson) } catch (e: Exception) { org.json.JSONArray() }
            val have = list.objects().map { it.str("key") }.toSet()
            for ((k, v) in senders) if (k !in have) list.put(JSONObject().put("key", k).put("channel", v.first).put("name", v.second).put("display", v.third))
            app.prefs.ignoredJson = list.toString()
            // This phone's other open requests from them go too.
            val lists = app.senderLists()
            for (r in app.inbox.all()) if (r.status in setOf("new", "maybe") && Senders.reason(r.channel, r.chat, lists).isNotEmpty()) {
                app.inbox.update(r.id) { it.status = "dismissed"; it.history.add("Sender ignored: never a request") }
            }
            if (app.pc.connected) {
                val forPc = org.json.JSONArray()
                pcIds.forEach { forPc.put(it) }
                for (id in localIds) app.inbox.get(id)?.let { r -> forPc.put(JSONObject().put("channel", r.channel).put("from", JSONObject().put("name", r.chat).put("chat", r.chat))) }
                bg({ app.pc.call("ignoreSenders", forPc) }) { _, err -> if (err != null) toast(err) }
            }
            dismissTicked()
        }
    }

    private fun statusText(s: String) = when (s) {
        "new" -> "New"; "dismissed" -> "Not a request"; "replied" -> "Replied"; "delivered" -> "Told"; "closed" -> "Closed"; "attention" -> "Copy had errors"; "maybe" -> "Maybe a request"; "copying" -> "Copying"; "ready" -> "Copy finished, not told yet"
        else -> s.replaceFirstChar { it.uppercase() }
    }

    private fun open(pcId: String? = null, localId: String? = null) {
        startActivity(Intent(this, RequestActivity::class.java).putExtra(RequestActivity.PC, pcId).putExtra(RequestActivity.LOCAL, localId))
    }

    // ---------------------------------------------------------------- find (offline, on this phone)
    private var findQuery = ""
    private var findResults: List<Catalog.Match>? = null
    private var findBusy = false

    // Kept between redraws, so typing is never interrupted by news from the PC.
    private val findBox by lazy {
        EditText(this).apply {
            hint = "folder 3046, HDD 123, janmashtami ahmedabad 2019…"
            inputType = InputType.TYPE_CLASS_TEXT
            imeOptions = EditorInfo.IME_ACTION_SEARCH
            setSingleLine()
            setOnEditorActionListener { _, action, ev ->
                if (action == EditorInfo.IME_ACTION_SEARCH || ev?.keyCode == KeyEvent.KEYCODE_ENTER) { runFind(); true } else false
            }
        }
    }

    private fun runFind() {
        val c = app.pc.catalog ?: return
        val q = findBox.text.toString().trim()
        if (q.isEmpty() || findBusy) return
        findQuery = q
        findBusy = true
        render()
        bg({ c.search(q, limit = 100) }) { res, err ->
            findBusy = false
            findResults = res ?: emptyList()
            if (err != null) toast(err)
            render()
        }
    }

    private fun renderFind() {
        val c = app.pc.catalog
        (findBox.parent as? android.view.ViewGroup)?.removeView(findBox)
        if (c == null) {
            content.addView(label(when {
                !app.prefs.paired -> "Pair with the PC once: it sends this phone a copy of the catalogue, which you can then search here anywhere, even with the PC off."
                app.pc.catalogError.isNotEmpty() -> app.pc.catalogError
                else -> "The catalogue comes from the PC the next time this phone reaches it (it is imported on the PC: Find Data → Import catalogue)."
            }, muted = true))
            content.addView(buttons(button("Scan a picture", outlined = true) { chooseScan() }))
            return
        }
        val when_ = if (c.version > 0) java.text.DateFormat.getDateInstance().format(java.util.Date(c.version)) else "?"
        content.addView(label("Catalogue of $when_ · ${"%,d".format(c.rows.size)} rows · searched on this phone", 13f, muted = true))
        if (app.pc.catalogError.isNotEmpty()) content.addView(label(app.pc.catalogError, 13f, muted = true))
        content.addView(findBox)
        content.addView(buttons(
            button(if (findBusy) "Searching…" else "Search") { runFind() },
            button("Scan a picture", outlined = true) { chooseScan() },
        ))
        val res = findResults ?: return
        content.addView(label(if (res.isEmpty()) "Nothing found for “$findQuery”." else "${res.size} found for “$findQuery”", 13f, muted = true))
        for (m in res) content.addView(matchCard(c, m))
    }

    // ---------------------------------------------------------------- scan a picture
    private fun chooseScan() {
        AlertDialog.Builder(this).setTitle("Read a request from a picture")
            .setItems(arrayOf("Take a photo (of a monitor, poster, list)", "Pick a picture or screenshot")) { _, i ->
                if (i == 0) {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera()
                    else askCamera.launch(Manifest.permission.CAMERA)
                } else pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            }.show()
    }

    private fun scanUri(u: Uri) {
        startActivity(Intent(this, ScanActivity::class.java).setData(u).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }

    private fun openCamera() {
        val dir = java.io.File(cacheDir, "scans").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // only the latest photo is kept
        val f = java.io.File(dir, "scan-${System.currentTimeMillis()}.jpg")
        photoUri = FileProvider.getUriForFile(this, "$packageName.files", f)
        takePhoto.launch(photoUri!!)
    }


    // ---------------------------------------------------------------- queue
    private fun pcCall(okText: String?, method: String, vararg args: Any?) {
        bg({ app.pc.call(method, *args) }) { _, err ->
            if (err != null) toast(err) else if (okText != null) toast(okText)
            refresh()
        }
    }

    private fun renderQueue() {
        content.addView(linkLine())
        val q = app.pc.queue()
        if (!app.prefs.paired || q == null) {
            content.addView(label("Pair with the PC to see and control the copy queue.", muted = true))
            return
        }
        val live = app.pc.connected
        val paused = q.optBoolean("paused")
        content.addView(label(if (paused) "Queue paused" else if (q.optBoolean("running")) "Copying" else "Queue idle", 17f, bold = true))
        if (live) {
            content.addView(buttons(
                if (paused) button("Resume") { pcCall("Resumed", "resume") } else button("Pause") { pcCall("Paused", "pause") },
                button("Skip this file", outlined = true) { confirm("Skip file", "Skip the file being copied now?", "Skip") { pcCall(null, "skip") } },
            ))
        }

        renderDrives(live)

        val current = q.optJSONObject("current")
        val jobs = q.optJSONArray("jobs").objects()
        if (jobs.isEmpty()) content.addView(label("Nothing in the queue.", muted = true))
        for (j in jobs) {
            val id = j.str("id")
            val status = j.str("status")
            val total = j.optDouble("bytesTotal", 0.0)
            val done = j.optDouble("bytesDone", 0.0)
            val parts = mutableListOf<android.view.View>(
                label(j.str("name"), bold = true),
                label("${status.replaceFirstChar { it.uppercase() }} · ${if (j.optBoolean("needsScan")) "files listed when the tape is ready" else "${j.optInt("done")}/${j.optInt("count")} files · ${bytes(done)} of ${bytes(total)}"} → ${j.str("dest")}", 13f, muted = true),
            )
            if (status == "running" && total > 0) {
                parts.add(ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000; progress = (done / total * 1000).toInt() })
                if (current != null && current.str("jobId") == id) {
                    parts.add(label("${current.str("phase")} ${current.str("file")} · ${bytes(current.optDouble("speed", 0.0))}/s", 13f, muted = true))
                }
            }
            if (j.str("holdReason").isNotBlank()) parts.add(label("⏸ ${j.str("holdReason")}", 13f))
            if (j.optInt("failed") > 0) parts.add(label("${j.optInt("failed")} failed", 13f))
            if (j.str("error").isNotBlank()) parts.add(label(j.str("error"), 13f))
            if (live) {
                val bs = mutableListOf<android.view.View>()
                when (status) {
                    "held" -> bs.add(button("Tape ready — start") {
                        val why = j.str("holdReason")
                        confirm("Start this copy?", "${if (why.isNotBlank()) "$why\n\n" else ""}Is the tape drive light steady now (not blinking)?", "Light is steady — start") {
                            pcCall("Started", "holdJob", id, false)
                        }
                    })
                    "queued" -> bs.add(button("Hold", outlined = true) { pcCall(null, "holdJob", id, true) })
                    "running" -> bs.add(button("Cancel", outlined = true) { confirm("Cancel copy", "Stop copying ${j.str("name")}?", "Stop") { pcCall("Cancelled", "cancelJob", id) } })
                    "failed" -> bs.add(button("Retry failed files") { pcCall("Retrying", "retryJob", id) })
                    "done" -> if ((j.optJSONArray("notify")?.length() ?: 0) > 0) bs.add(button("Tell them again", outlined = true) { pcCall("Sent", "notifyJob", id) })
                }
                if (bs.isNotEmpty()) parts.add(buttons(*bs.toTypedArray()))
            }
            content.addView(card(*parts.toTypedArray()))
        }
    }

    // Drives connected to the PC. Disks are found and scanned by the PC within 15 seconds of
    // being plugged in; tapes are never read until you say the drive light is steady.
    private fun renderDrives(live: Boolean) {
        val all = app.pc.state.optJSONObject("status")?.optJSONObject("drives")
        val drives = app.pc.drives()
        content.addView(label("Drives on the PC", 17f, bold = true))
        if (drives.isEmpty()) content.addView(label("No drives connected (besides the system drive).", 13f, muted = true))
        for (d in drives) {
            val root = d.str("root")
            val name = "${root.trimEnd('\\', '/')} ${d.str("label")}".trim()
            val status = d.str("status")
            val tape = d.optBoolean("tape")
            val counts = "${d.optInt("recordings")} recordings${if (d.optInt("episodes") > 0) ", ${d.optInt("episodes")} episodes" else ""}"
            val tapeReady = { what: String ->
                confirm("Tape ready?", "Scan $name now?\n\nOnly if the tape is fully loaded and the drive light is steady (not blinking).", "Light is steady — scan") {
                    toast("Scanning $name… this can take a few minutes")
                    pcCall(what, "scanTape", root)
                }
            }
            content.addView(when {
                tape && status != "tape-scanned" -> card(
                    label("⏸ $name · LTO tape, waiting", bold = true),
                    label("Tapes are never read on their own. Wait until the drive light is steady.", 13f, muted = true),
                    if (live) button("Tape ready — scan") { tapeReady("Tape scanned") } else label("Connect to the PC to start it.", 13f, muted = true),
                )
                status == "not-ready" -> card(
                    label("⏳ $name · not answering", bold = true),
                    label("Windows got no answer from this drive: a tape may still be loading.", 13f, muted = true),
                    if (live) button("Ready — scan", outlined = true) { tapeReady("Scanned") } else label("Connect to the PC to start it.", 13f, muted = true),
                )
                status == "scanning" -> card(label("🔄 $name · scanning…", bold = true))
                else -> card(label("${if (tape) "📼" else "💽"} $name · $counts", bold = true))
            })
        }
        val tapes = all?.optJSONArray("tapes")?.length() ?: 0
        if (tapes > 0) content.addView(label("$tapes tape${if (tapes > 1) "s" else ""} remembered from earlier scans: their recordings are found even when not loaded.", 13f, muted = true))
        if (live) {
            content.addView(buttons(button("Rescan disks", outlined = true) {
                toast("Rescanning the PC's disks…")
                bg({ app.pc.call("rescanDrives") }) { n, err ->
                    toast(err ?: "Disks rescanned: $n recordings known")
                    refresh()
                }
            }))
        }
    }

    // ---------------------------------------------------------------- PC
    private fun renderPc() {
        val p = app.prefs
        content.addView(card(
            label("PC", 17f, bold = true),
            label(when {
                !p.paired -> "Not paired. On the PC open AV Courier → Settings → Phone → Pair a phone, then scan the code."
                app.pc.connected -> "Connected to ${p.hosts.first()}:${p.port}"
                else -> "Paired with ${p.hosts.joinToString(" / ")}:${p.port}, not reachable right now."
            }),
            buttons(
                button("Scan pairing code") {
                    scan.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt("Scan the code in AV Courier → Settings → Phone").setBeepEnabled(false).setOrientationLocked(false))
                },
                button("Type the code", outlined = true) { typeCode() },
            ),
            if (p.paired) button("Unpair", outlined = true) { confirm("Unpair", "Forget this PC? It will need a new code.", "Unpair") { app.pc.unpair(); render() } } else android.view.View(this),
        ))
        content.addView(card(
            label("Catching requests", 17f, bold = true),
            label(if (CatchService.enabled(this)) "Notification access: allowed ✓" else "Notification access: not allowed yet"),
            button("Notification access settings", outlined = true) { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) },
            label("Remind me of unanswered requests after ${p.remindMin} minutes"),
            button("Change", outlined = true) {
                ask("Remind after (minutes)", p.remindMin.toString(), "Save", multiLine = false) { v ->
                    v.trim().toIntOrNull()?.takeIf { it >= 15 }?.let { p.remindMin = it }
                    render()
                }
            },
            label("Muted chats raise no notification, so they are not seen. Photos usually arrive only as “📷 Photo”: ask for the details in words, or open the chat on the PC.", 13f, muted = true),
        ))
    }

    private fun typeCode() {
        val host = EditText(this).apply { hint = "PC address, e.g. 192.168.1.20"; setText(app.prefs.hosts.firstOrNull() ?: ""); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI }
        val port = EditText(this).apply { hint = "Port"; setText(app.prefs.port.toString()); inputType = InputType.TYPE_CLASS_NUMBER }
        val code = EditText(this).apply { hint = "6-digit code"; inputType = InputType.TYPE_CLASS_NUMBER }
        AlertDialog.Builder(this).setTitle("Pair with the PC")
            .setView(vbox(host, port, code).apply { setPadding(dp(20), dp(8), dp(20), 0) })
            .setPositiveButton("Pair") { _, _ ->
                doPair(host.text.toString().split(',').map { it.trim() }.filter { it.isNotEmpty() }, port.text.toString().toIntOrNull() ?: 8765, code.text.toString())
            }
            .setNegativeButton("Cancel", null).show()
    }

    /** avcourier://pair?h=192.168.1.20,10.0.0.4&p=8765&c=123456 */
    private fun pairFrom(u: Uri) {
        if (u.scheme != "avcourier" || u.host != "pair") return toast("That is not an AV Courier pairing code.")
        val hosts = (u.getQueryParameter("h") ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
        val code = u.getQueryParameter("c") ?: ""
        if (hosts.isEmpty() || code.isEmpty()) return toast("The code has no PC address. Type the code instead.")
        doPair(hosts, u.getQueryParameter("p")?.toIntOrNull() ?: 8765, code)
    }

    private fun doPair(hosts: List<String>, port: Int, code: String) {
        if (hosts.isEmpty()) return toast("Type the PC address shown under the code.")
        toast("Pairing…")
        bg({ app.pc.pair(hosts, port, code) }) { problem, err ->
            val msg = err ?: problem
            if (msg != null) toast(msg) else { toast("Paired with the PC ✓"); app.pc.forwardPending(); refresh() }
        }
    }
}
