package com.house.avcourier.companion

import org.json.JSONObject
import java.io.BufferedReader
import java.text.Normalizer
import kotlin.math.abs

/**
 * The PC's catalogue, searched on the phone even when the PC is off.
 * The PC sends its search index ready made (Catalog.phoneExport() in electron/catalog.js,
 * served gzipped at /api/catalog: a header line, then one JSON line per row); search()
 * below is a line-by-line port of Catalog.search() there. CatalogTest compares the two.
 */
class Catalog private constructor(val version: Long, val sheets: List<Sheet>, val rows: List<Row>) {

    class Sheet(val name: String, val file: String, val kind: String, val backups: List<String>)

    class Ser(val authors: List<String>, val type: String, val era: String)

    class Row(
        val sheet: Int, val kind: String, val text: String, what: String, val ids: Set<String>, val keys: List<String>,
        val folder: String, val epNo: String, val seriesTok: Set<String>?, val ser: Ser?, val iso: String,
        val id: String, val rawId: String, val title: String, val event: String, val place: String, val date: String,
        val series: String, val seriesLabel: String, val loc: List<String>, val rowNo: Int,
    ) {
        // "text" is the row's words joined by single spaces: a word is in the row when " word " is in " text ".
        private val padded = " $text "
        private val whatPadded = " $what "
        val dates: Set<String> = if (iso.isEmpty()) emptySet() else setOf(iso, iso.take(7), iso.take(4))
        fun hasWord(w: String) = padded.contains(" $w ")
        fun whatHas(w: String) = whatPadded.contains(" $w ")
        fun tokens() = text.split(' ').filter { it.length > 1 || it.any(Char::isDigit) }
    }

    class Match(val row: Row, val score: Int, val why: List<String>)

    private val byId: Map<String, List<Row>> = HashMap<String, MutableList<Row>>().also { m ->
        for (r in rows) for (k in r.keys) m.getOrPut(k) { mutableListOf() }.add(r)
    }

    companion object {
        /** Reads the PC's file (already un-gzipped) line by line, so it never sits in memory twice. */
        fun read(reader: BufferedReader): Catalog {
            val head = JSONObject(reader.readLine() ?: throw IllegalArgumentException("Empty catalogue"))
            val sa = head.optJSONArray("sheets")
            val sheets = (0 until (sa?.length() ?: 0)).map { i ->
                val s = sa!!.getJSONObject(i)
                val b = s.optJSONArray("backups")
                Sheet(s.str("name"), s.str("file"), s.str("kind").ifEmpty { "raw" }, (0 until (b?.length() ?: 0)).map { b!!.optString(it) })
            }
            val rows = ArrayList<Row>(head.optInt("rows"))
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isNotBlank()) rows.add(row(JSONObject(line), sheets))
            }
            return Catalog(head.optLong("version"), sheets, rows)
        }

        private fun list(o: JSONObject, k: String): List<String> {
            val a = o.optJSONArray(k) ?: return emptyList()
            return (0 until a.length()).map { a.optString(it) }
        }

        private fun row(o: JSONObject, sheets: List<Sheet>): Row {
            val si = o.optInt("s")
            val ser = o.optJSONArray("ser")?.let { Ser(it.optString(0).split(','), it.optString(1), it.optString(2)) }
            return Row(
                sheet = si, kind = sheets.getOrNull(si)?.kind ?: "raw", text = o.str("t"), what = o.str("w"),
                ids = list(o, "i").toHashSet(), keys = list(o, "k"), folder = o.str("f"), epNo = o.str("n"),
                seriesTok = if (o.isNull("st")) null else o.str("st").split(' ').filter { it.isNotEmpty() }.toSet(),
                ser = ser, iso = o.str("d"), id = o.str("id"), rawId = o.str("raw"), title = o.str("title"),
                event = o.str("event"), place = o.str("place"), date = o.str("date"), series = o.str("series"),
                seriesLabel = o.str("sl"), loc = list(o, "loc"), rowNo = o.optInt("row"),
            )
        }

        // ---------------------------------------------------------------- catalog.js helpers
        private val MARKS = Regex("[̀-ͯ]")
        private val NON_WORD = Regex("[^a-z0-9]+")
        fun norm(s: String?): String =
            Normalizer.normalize((s ?: "").lowercase(), Normalizer.Form.NFKD).replace(MARKS, "").replace(NON_WORD, " ").trim()

        fun tokens(s: String?): List<String> = norm(s).split(' ').filter { it.length > 1 || it.any(Char::isDigit) }

        fun compact(s: String) = s.uppercase().replace(Regex("[^A-Z0-9]"), "")

        private val MONTH_WORDS = Regex("^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$")
        private val HINT_WORDS = setOf("nm", "niruma", "dd", "deepakbhai", "pujyashree", "informal", "formal", "master", "mini", "dv", "dvcam", "hd", "4k", "episode", "episodes", "ep", "raw")
        private val STOP = setOf(
            "the", "and", "for", "please", "send", "need", "data", "copy", "from", "with", "of", "to", "me", "pls", "plz", "kindly", "can", "you",
            "give", "want", "footage", "video", "videos", "all", "that", "this", "on", "in", "at", "is", "it", "hi", "hello", "bhai", "ji", "folder",
            "fld", "no", "number", "drive", "tape", "raw", "files", "file", "recording", "i", "think", "was", "which", "where",
        )
        private val I = RegexOption.IGNORE_CASE

        /** What a request says about the series: "NM", "informal", "mini dv", "HD", "episode"… */
        fun seriesHints(t: String): Map<String, String> {
            val h = HashMap<String, String>()
            if (Regex("""\b(nm|niruma)\b""", I).containsMatchIn(t)) h["author"] = "NM"
            else if (Regex("""\b(dd|deepakbhai|pujyashree)\b""", I).containsMatchIn(t)) h["author"] = "DD"
            if (Regex("""\binformal\b|\bmini ?dv\b""", I).containsMatchIn(t)) h["type"] = "I"
            else if (Regex("""\bformal\b|\bmaster\b""", I).containsMatchIn(t)) h["type"] = "F"
            if (Regex("""\b(dv|dvcam|mini ?dv)\b""", I).containsMatchIn(t)) h["era"] = "DV"
            else if (Regex("""\b(hd|4k)\b""", I).containsMatchIn(t)) h["era"] = "HD"
            if (Regex("""\bepisodes?\b|\bep\.?\s*\d""", I).containsMatchIn(t)) h["kind"] = "episode"
            else if (Regex("""\braw\b""", I).containsMatchIn(t)) h["kind"] = "raw"
            return h
        }

        /** One edit apart (typo tolerance for names). */
        fun near(a: String, b: String): Boolean {
            if (a == b) return true
            var i = 0
            var j = 0
            var edits = 0
            while (i < a.length && j < b.length) {
                if (a[i] == b[j]) { i++; j++; continue }
                if (++edits > 1) return false
                if (a.length > b.length) i++ else if (b.length > a.length) j++ else { i++; j++ }
            }
            return edits + (a.length - i) + (b.length - j) <= 1
        }

        // "DD" and "Satsang" may be left out: "Sevarthi episode 98" is DD Sevarthi Satsang 98 (catalog.js seriesAsked).
        private val SERIES_OPTIONAL = setOf("dd", "satsang")
        fun seriesAsked(tok: Set<String>, said: Set<String>): Boolean {
            val need = tok.filter { it !in SERIES_OPTIONAL }
            return if (need.isNotEmpty()) need.all { it in said } else tok.all { it == "dd" || it in said }
        }

        private val FOLDER_SAID = Regex("""\b(?:folder|fld|f)\s*(?:no\.?|number|#)?\s*0*(\d{1,5})\b""", I)
        private val RAW_ID = Regex("""\b[A-Z]{2,4}-[FI]-(?:HD|4K|DV)-\d{3,5}\b""", I)
        private val BARE_NUMBER = Regex("""(?:^|[\s#])0*(\d{3,4})\b""")
        private val ISO_LIKE = Regex("""^\d{4}(-\d{2}){0,2}$""")
        private fun isYear(n: Int) = n in 1950..2099
    }

    /**
     * Port of Catalog.search(query) in electron/catalog.js, query { text, ids, numbers, dates }.
     * Find uses the text alone; a request also passes what Heuristic read from it.
     */
    fun search(
        text: String, qIds0: List<String> = emptyList(), numbers: List<String> = emptyList(), qDates0: List<String> = emptyList(),
        limit: Int = 50, now: Long = System.currentTimeMillis(),
    ): List<Match> {
        // Exact Raw Video Ids ("DD-F-4K-3049-E", "dd f 4k 3049 e"): any run of 3-6 short parts.
        val exact = HashSet<Row>()
        val parts = text.split(Regex("[^A-Za-z0-9]+")).filter { it.isNotEmpty() }
        var i = 0
        while (i < parts.size) {
            var k = minOf(6, parts.size - i)
            while (k >= 3) {
                val hit = byId[compact(parts.subList(i, i + k).joinToString(""))]
                if (hit != null) { exact.addAll(hit); i += k - 1; break }
                k--
            }
            i++
        }

        val folders = LinkedHashSet<String>()
        for (m in FOLDER_SAID.findAll(text)) folders.add(m.groupValues[1].toLong().toString())
        val namesRecording = folders.isNotEmpty() || RAW_ID.containsMatchIn(text)
        // "hdd 123" is a drive, not folder 123; "DD Master 418" stays a folder.
        val textIds = Heuristic.ids(text)
        val mediaNumbers = textIds.filter { x ->
            x.contains(':') && !Regex("""^master\d""").containsMatchIn(textIds.find { y -> y.endsWith(x.split(':')[1]) && !y.contains(':') } ?: "")
        }.map { it.split(':')[1] }.toSet()
        for (m in BARE_NUMBER.findAll(text)) {
            val n = m.groupValues[1].toInt()
            if (!isYear(n) && n.toString() !in mediaNumbers) folders.add(n.toString())
        }

        val qIds = LinkedHashSet<String>()
        for (x in qIds0) qIds.addAll(Heuristic.ids(x).ifEmpty { listOf(x) })
        qIds.addAll(textIds)
        for (n in numbers) n.toLongOrNull()?.let { qIds.add("#$it") }
        for (f in folders) { qIds.remove("folder$f"); qIds.remove("fld$f"); qIds.remove("f$f") }
        val qDates = LinkedHashSet<String>()
        (qDates0 + Heuristic.dates(text, years = true, now = now)).filterTo(qDates) { ISO_LIKE.matches(it) }

        val hints = seriesHints(text)
        val allWords = LinkedHashSet(tokens(text)).filter { it !in STOP && !it.all(Char::isDigit) && !MONTH_WORDS.matches(it) }
        val words = allWords.filter { it !in HINT_WORDS }
        // Episode numbers come right after the series name: each number keeps the few words before it.
        val tl = norm(text).split(' ').filter { it.isNotEmpty() }
        val epWindow = LinkedHashMap<String, MutableSet<String>>()
        tl.forEachIndexed { idx, t ->
            if (Regex("""^\d{1,5}$""").matches(t) && !isYear(t.toInt())) {
                epWindow.getOrPut(t.toInt().toString()) { LinkedHashSet() }.addAll(tl.subList(maxOf(0, idx - 5), idx))
            }
        }
        val nums = epWindow.keys
        if (exact.isEmpty() && folders.isEmpty() && qIds.isEmpty() && qDates.isEmpty() && words.isEmpty() && nums.isEmpty()) return emptyList()

        val results = ArrayList<Match>()
        for (e in rows) {
            var score = 0
            val why = ArrayList<String>()
            if (e in exact) { score += if (e.kind == "episode" && e.ser != null && e.epNo.isEmpty()) 120 else 200; why.add("id") }
            if (e.folder.isNotEmpty() && e.folder in folders) { score += 70; why.add("folder ${e.folder}") }
            // Every word of the series name must be asked for: "aptavani 14" is not episode 14 of Aptavani-10(P).
            if (e.epNo.isNotEmpty() && e.epNo in nums && e.seriesTok != null && seriesAsked(e.seriesTok, epWindow[e.epNo]!!)) {
                score += 150; why.add("episode ${e.epNo}")
            }
            // The same folder number exists in several series: what the request says decides.
            if (e.ser != null) {
                for (k in listOf("author", "type", "era")) {
                    val hint = hints[k] ?: continue
                    val ok = when (k) { "author" -> hint in e.ser.authors; "type" -> e.ser.type == hint; else -> e.ser.era == hint }
                    if (ok) { score += 15; why.add(hint) } else score -= 25
                }
            }
            if (hints["kind"] == e.kind) score += 10
            for (id in qIds) if (id in e.ids) { score += if (id.startsWith("#")) 20 else if (id.contains(':')) 30 else 40; why.add(id) }
            for (d in qDates) if (d in e.dates) { score += when (d.length) { 10 -> 40; 7 -> 25; else -> 20 }; why.add(d) }
            var hits = 0
            for (w in words) {
                if (e.hasWord(w)) { hits++; score += if (e.whatHas(w)) 16 else 10 }
                else if (w.length >= 4 && e.text.contains(w)) { hits++; score += 6 }
                else if (w.length >= 5) for (t in e.tokens()) if (abs(t.length - w.length) <= 1 && near(t, w)) { hits++; score += 4; break }
            }
            if (words.size > 1 && hits == words.size) score += 10
            // A date that was asked for and is missing counts against the row.
            if (qDates.isNotEmpty() && qDates.none { it in e.dates }) score -= 8
            if (score > 0 && why.size + hits > 0) results.add(Match(e, score, why))
        }
        results.sortByDescending { it.score } // stable, like Array.prototype.sort
        // When the request names the recording, rows sharing only a word with it are noise.
        val named = results.any { m -> m.why.any { it == "id" || it.startsWith("folder ") || it.startsWith("episode ") } }
        val kept = if (namesRecording || named) results.filter { it.why.isNotEmpty() } else results
        return kept.take(limit)
    }

    /** Search with what Heuristic reads from a request, as the PC does for its Requests page. */
    fun forRequest(text: String, limit: Int = 15): List<Match> {
        val per = forItems(text, limit)
        if (per.size < 2) return per.firstOrNull()?.second ?: emptyList()
        // Taken in turns (each item's best, then each item's second…), as electron/main.js matchRequest.
        val cap = minOf(30, maxOf(limit, per.size * 4))
        val out = LinkedHashMap<Row, Match>()
        for (i in 0 until limit) for ((_, list) in per) if (out.size < cap) list.getOrNull(i)?.let { out.putIfAbsent(it.row, it) }
        return out.values.toList()
    }

    /** Each listed item of a request with its own matches; a request that is not a list is one item. */
    fun forItems(text: String, limit: Int = 15): List<Pair<String, List<Match>>> =
        Heuristic.items(text).map { t -> val h = Heuristic.heuristic(t); t to search(t, h.ids, h.numbers, h.dates, limit) }

    // ---------------------------------------------------------------- showing a row
    fun backups(r: Row): List<Pair<String, String>> =
        (sheets.getOrNull(r.sheet)?.backups ?: emptyList()).mapIndexed { i, label -> label.replace(Regex("""\s*backup$""", I), "") to r.loc.getOrElse(i) { "" } }

    fun heading(r: Row) = if (r.kind == "episode") "Episode · ${r.series} ${r.epNo}".trim() else r.seriesLabel

    /** electron/notifier.js rowLine(): one row in a "here is where it is" reply. */
    fun line(r: Row): String {
        val what = listOf(r.title, if (r.event.isNotEmpty() && r.event != r.title) "(${r.event})" else "").filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { r.id }
        val head = listOf(if (r.kind == "episode") "Episode ${r.series} ${r.epNo}: $what" else what, r.place, r.date).filter { it.isNotEmpty() }.joinToString(", ")
        val ref = if (r.kind == "episode") (if (r.rawId.isNotEmpty()) "from ${r.rawId}" else "")
        else listOf(if (r.folder.isNotEmpty()) "Folder ${r.folder}" else "", r.id).filter { it.isNotEmpty() }.joinToString(" · ")
        val where = backups(r).filter { it.second.isNotEmpty() }.joinToString(" · ") { "${it.first}: ${it.second}" }.ifEmpty { "not on any backup yet" }
        return "• $head${if (ref.isNotEmpty()) " · $ref" else ""}\n   $where"
    }
}
