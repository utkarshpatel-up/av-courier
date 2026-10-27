package com.house.avcourier.companion

import java.util.Calendar

/**
 * Is this message a data request? A line-by-line port of `heuristic()` in
 * electron/extract.js, with the `ids()` and `dates()` helpers from
 * electron/catalog.js. Keep the two in step: HeuristicTest holds a table of
 * results taken from the JS version.
 */
object Heuristic {
    /** Requests score at least [REQUEST_FLOOR]; everything else stays below [THRESHOLD]. */
    const val THRESHOLD = 24
    const val REQUEST_FLOOR = 30

    data class Result(
        val score: Int,
        val isRequest: Boolean,
        val ids: List<String>,
        val numbers: List<String>,
        val dates: List<String>,
        val summary: String,
    )

    // A request = someone asking (English, or the Gujarati/Hindi "joie che", "mokalo",
    // "bhejo", "chahiye") for archive material. Asking words alone are not enough:
    // bank, bill and delivery messages "request", say "please" and carry dates too.
    private val ASK = Regex(
        """\b(need|needed|send|share|give|want|require|required|request|can you|joie|joiye|joiae|joiti|jove|mokal\w*|moklo|bhej\w*|chahiye|chaiye|chahie|aapo|apo|apjo|aapjo|aapsho|mangta|dedo|de do)\b""",
        RegexOption.IGNORE_CASE,
    )
    // Politeness is not asking: "Please plan the video setup" is an instruction.
    private val POLITE = Regex("""\b(please|pls|plz|kindly)\b""", RegexOption.IGNORE_CASE)
    private val ARCHIVE = Regex(
        """\b(footage|videos?|clips?|recordings?|raw|data|satsang|katha|shibir|parayan|episodes?|audio|program(me)?|darshan|vidhi|gnanvidhi|aptavani|vitraag|janma ?jayanti|guru ?purnima|bhakti|pratikraman|master|mini ?dv|dvcam|lto|tape|hdd|ssd)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val ARCHIVE_WEAK = Regex("""\b(files?|photos?|folder|drive|copy)\b""", RegexOption.IGNORE_CASE)
    // Money, shopping and service messages: never a data request on their own.
    private val NOISE = Regex(
        """\b(bill|billing|payment|pay now|due|credit|debit|card|bank|emi|loan|invoice|premium|policy|insurance|otp|offer|cashback|order|delivered|delivery|refund|return request|recharge|kyc|a/c|account|upi|transaction|statement|renewal|dear customer|subscribe|unsubscribe|reward|coupon|sale|discount|video calls?|for free)\b|₹|\brs\.?\s*\d|\binr\b|https?://""",
        RegexOption.IGNORE_CASE,
    )
    // WhatsApp wraps previews in direction marks (U+202A … U+202C) and other invisible characters.
    private val INVISIBLE = Regex("[​-‏‪-‮⁦-⁩﻿]")
    private val ID_KIND = Regex("""^(hdd|hd|drive|d|disk|ssd|tape|t|lto|dv|bt)\d+$""")
    private val YEARS = Regex("""\b(19[5-9]\d|20\d\d)\b""")
    private val NUMBERS = Regex("""\b(?:drive|hdd|disk|ssd|tape|lto)\s*(?:no\.?|number|#)?\s*0*(\d{1,6})\b""", RegexOption.IGNORE_CASE)
    // Raw Video Ids, folder or episode numbers name a recording outright.
    private val RAW_ID = Regex("""\b[A-Z]{2,4}(?:,\s*[A-Z]{2,4})?-[FI]-(?:HD|4K|DV)-\d{3,5}\b""", RegexOption.IGNORE_CASE)
    private val FOLDER_OR_EPISODE = Regex("""\b(folder|episode|ep)\s*(?:no\.?|number|#)?\s*\d{1,5}\b""", RegexOption.IGNORE_CASE)

    fun clean(text: String?) = (text ?: "").replace(INVISIBLE, "").trim()

    fun heuristic(text: String?, now: Long = System.currentTimeMillis()): Result {
        val t = clean(text)
        fun count(re: Regex) = re.findAll(t).map { it.value.lowercase() }.toSet().size
        val ask = count(ASK)
        val archive = count(ARCHIVE) + count(ARCHIVE_WEAK) / 2.0
        val noise = count(NOISE)
        val foundIds = ids(t).filter { ID_KIND.matches(it) }
        val foundDates = dates(t, now = now)
        val years = YEARS.findAll(t).count()
        val numbers = NUMBERS.findAll(t).map { it.groupValues[1] }.toList()
        val strong = RAW_ID.containsMatchIn(t) || FOLDER_OR_EPISODE.containsMatchIn(t) || (foundIds.isNotEmpty() && ask > 0)
        var raw = minOf(48, ask * 12) + minOf(6, count(POLITE) * 6) + minOf(40.0, archive * 14) + foundIds.size * 20 + minOf(2, foundDates.size) * 8 +
            minOf(1, years) * 6 + (if (strong) 40 else 0) - noise * 15
        if (t.endsWith("?") && ask > 0) raw += 5
        val score = Math.round(raw).toInt().coerceIn(0, 100)
        val isRequest = strong || (ask > 0 && archive >= 1 && noise == 0) || (ask > 0 && archive >= 2 && noise <= 1)
        return Result(
            score = if (isRequest) maxOf(score, REQUEST_FLOOR) else minOf(score, THRESHOLD - 1),
            isRequest = isRequest,
            ids = foundIds,
            numbers = numbers,
            dates = foundDates,
            summary = t.split('\n')[0].take(140),
        )
    }

    // ---------------------------------------------------------------- catalog.js ids()
    private val MONTHS = mapOf(
        "jan" to 1, "feb" to 2, "mar" to 3, "apr" to 4, "may" to 5, "jun" to 6, "jul" to 7, "aug" to 8,
        "sep" to 9, "sept" to 9, "oct" to 10, "nov" to 11, "dec" to 12,
    )
    private val MONTH_WORDS = Regex("""^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$""")
    private val FAMILY = mapOf(
        "hdd" to "d", "hd" to "d", "drive" to "d", "disk" to "d", "disc" to "d", "ssd" to "d", "d" to "d", "master" to "d",
        "tape" to "t", "t" to "t", "tp" to "t", "lto" to "t", "bt" to "t", "nas" to "n", "card" to "c", "sd" to "c",
    )
    private val ID_RE = Regex("""\b([a-z]{1,8})[\s\-_#./:]*(?:no\.?\s*|number\s*)?0*(\d{1,6})\b""", RegexOption.IGNORE_CASE)

    /** Media names: "HDD-0123" -> hdd123 and d:123; month names are never a prefix. */
    fun ids(text: String?): List<String> {
        val out = LinkedHashSet<String>()
        for (m in ID_RE.findAll(text ?: "")) {
            val p = m.groupValues[1].lowercase()
            if (MONTH_WORDS.matches(p)) continue
            out.add(p + m.groupValues[2])
            FAMILY[p]?.let { out.add("$it:${m.groupValues[2]}") }
        }
        return out.toList()
    }

    // ---------------------------------------------------------------- catalog.js dates()
    private fun pad(n: Int) = n.toString().padStart(2, '0')

    private fun isoDate(year: Int, mo: Int, d: Int): String? {
        val y = if (year < 100) year + 2000 else year
        if (!(mo in 1..12 && d in 1..31 && y > 1950 && y < 2100)) return null
        return "$y-${pad(mo)}-${pad(d)}"
    }

    private fun monthOf(w: String): Int? {
        val l = w.lowercase()
        return MONTHS[l.take(4)] ?: MONTHS[l.take(3)]
    }

    private val YMD = Regex("""\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b""")
    private val DMY = Regex("""\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b""")
    private val D_MON_Y = Regex("""\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([a-z]{3,9})[\s\-/.,]*(\d{2,4})\b""", RegexOption.IGNORE_CASE)
    private val MON_D_Y = Regex("""\b([a-z]{3,9})[\s\-/.]*(\d{1,2})(?:st|nd|rd|th)?[\s,\-/.]+(\d{4})\b""", RegexOption.IGNORE_CASE)
    private val MON_Y = Regex("""\b([a-z]{3,9})[\s\-/.,']*(\d{4})\b""", RegexOption.IGNORE_CASE)
    private val D_MON = Regex("""\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?![\s\-/.,']*\d)""", RegexOption.IGNORE_CASE)

    /**
     * Dates the way people write them: 16-08-26, 16/8/2026, 16 Aug 26, Dt-16-Aug-26, Aug 16 2026, 2026-08-16.
     * Partial dates come back as "2026-08"; with [years], also "2019".
     */
    fun dates(text: String?, noYear: Boolean = true, years: Boolean = false, now: Long = System.currentTimeMillis()): List<String> {
        val s = text ?: ""
        val out = LinkedHashSet<String>()
        fun g(m: MatchResult, i: Int) = m.groupValues[i]
        for (m in YMD.findAll(s)) isoDate(g(m, 1).toInt(), g(m, 2).toInt(), g(m, 3).toInt())?.let { out.add(it) }
        for (m in DMY.findAll(s)) isoDate(g(m, 3).toInt(), g(m, 2).toInt(), g(m, 1).toInt())?.let { out.add(it) }
        for (m in D_MON_Y.findAll(s)) {
            val mo = monthOf(g(m, 2)) ?: continue
            isoDate(g(m, 3).toInt(), mo, g(m, 1).toInt())?.let { out.add(it) }
        }
        for (m in MON_D_Y.findAll(s)) {
            val mo = monthOf(g(m, 1)) ?: continue
            isoDate(g(m, 3).toInt(), mo, g(m, 2).toInt())?.let { out.add(it) }
        }
        val covered = out.map { it.take(7) }
        for (m in MON_Y.findAll(s)) {
            val mo = monthOf(g(m, 1)) ?: continue
            val y = g(m, 2).toInt()
            if (y > 1950 && y < 2100) {
                val ym = "${g(m, 2)}-${pad(mo)}"
                if (ym !in covered) out.add(ym)
            }
        }
        // "16 Aug" with no year: the most recent 16 Aug.
        if (noYear) {
            val today = Calendar.getInstance().apply { timeInMillis = now }
            for (m in D_MON.findAll(s)) {
                val mo = MONTHS.getValue(g(m, 2).lowercase())
                val d = g(m, 1).toInt()
                var y = today.get(Calendar.YEAR)
                val candidate = Calendar.getInstance().apply { clear(); set(y, mo - 1, d) } // lenient, like JS Date
                if (candidate.timeInMillis > now) y--
                isoDate(y, mo, d)?.let { out.add(it) }
            }
        }
        if (years) {
            for (m in YEARS.findAll(s)) {
                val y = m.value
                if (out.none { it.startsWith(y) }) out.add(y)
            }
        }
        return out.toList()
    }
}
