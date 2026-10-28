package com.house.avcourier.companion

import org.w3c.dom.Element
import java.io.ByteArrayInputStream
import java.math.BigDecimal
import java.time.LocalDate
import java.util.zip.ZipInputStream
import javax.xml.parsers.DocumentBuilderFactory

/**
 * A request shared as a spreadsheet: each row becomes one "• " line of the request's words,
 * labelled with its column names, so the rows are searched and listed one by one
 * (Heuristic.items). Mirrors electron/sheet.js: the same lines come out on the PC.
 *
 * Read here: .xlsx / .xlsm (a zip of XML) and CSV / TSV. The old binary .xls, .xlsb and
 * OpenDocument .ods need the PC: [readsOnPhone] says which.
 */
object Sheet {
    const val MAX_ROWS = 150
    private val ANY = Regex("""\.(xlsx|xlsm|xls|xlsb|csv|tsv|ods)$""", RegexOption.IGNORE_CASE)
    private val HERE = Regex("""\.(xlsx|xlsm|csv|tsv)$""", RegexOption.IGNORE_CASE)
    private val TYPES = Regex("spreadsheet|excel|csv|comma-separated|tab-separated", RegexOption.IGNORE_CASE)

    fun isSheet(name: String?, type: String? = null) = ANY.containsMatchIn(name.orEmpty()) || TYPES.containsMatchIn(type.orEmpty())
    fun readsOnPhone(name: String?, type: String? = null): Boolean =
        HERE.containsMatchIn(name.orEmpty()) || (!ANY.containsMatchIn(name.orEmpty()) && Regex("csv|comma-separated|tab-separated|openxmlformats", RegexOption.IGNORE_CASE).containsMatchIn(type.orEmpty()))

    /** One cell: words, a number or a date (Excel keeps dates as day numbers with a date format). */
    sealed class Cell {
        data class Text(val s: String) : Cell()
        data class Num(val n: Double) : Cell()
        data class Day(val d: LocalDate) : Cell()
    }

    class Result(val text: String, val rows: Int)

    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    fun cellText(c: Cell?): String = when (c) {
        null -> ""
        is Cell.Text -> c.s.replace(Regex("""\s+"""), " ").trim()
        is Cell.Num -> BigDecimal.valueOf(c.n).stripTrailingZeros().toPlainString()
        is Cell.Day -> "${c.d.dayOfMonth} ${MONTHS[c.d.monthValue - 1]} ${c.d.year}"
    }

    // A first row of only words (no digits anywhere: "Folder No.", not "DD-F-HD-3050-E") names the columns.
    private fun isHeader(row: List<Cell?>) = row.count { cellText(it).isNotEmpty() } >= 2 &&
        row.all { it == null || (it is Cell.Text && !it.s.any(Char::isDigit)) }

    /** Reads [bytes] of a file called [name]; throws with a readable message when it cannot. */
    fun read(bytes: ByteArray, name: String): Result {
        val sheets = if (Regex("""\.(csv|tsv)$""", RegexOption.IGNORE_CASE).containsMatchIn(name) || !isZip(bytes)) listOf(csv(String(bytes, Charsets.UTF_8).removePrefix("﻿")))
            else xlsx(bytes)
        return lines(sheets)
    }

    fun lines(sheets: List<List<List<Cell?>>>): Result {
        val out = ArrayList<String>()
        var total = 0
        for (all0 in sheets) {
            val all = all0.filter { r -> r.any { cellText(it).isNotEmpty() } }
            if (all.isEmpty()) continue
            val head = if (isHeader(all[0])) all[0].map(::cellText) else null
            val body = if (head != null) all.drop(1) else all
            total += body.size
            for (r in body) {
                if (out.size >= MAX_ROWS) break
                val cells = r.mapIndexed { i, c -> head?.getOrNull(i)?.takeIf { it.isNotEmpty() } to cellText(c) }.filter { it.second.isNotEmpty() }
                if (cells.isEmpty()) continue
                out.add("• " + cells.joinToString(" · ") { (h, v) -> if (h != null) "$h: $v" else v })
            }
        }
        val more = total - out.size
        return Result(out.joinToString("\n") + if (more > 0) "\n\n($more more rows not read)" else "", out.size)
    }

    private fun isZip(b: ByteArray) = b.size > 4 && b[0] == 'P'.code.toByte() && b[1] == 'K'.code.toByte()

    // ---------------------------------------------------------------- CSV / TSV
    fun csv(text: String): List<List<Cell?>> {
        val first = text.lineSequence().firstOrNull().orEmpty()
        val sep = listOf('\t', ';', ',').maxByOrNull { c -> first.count { it == c } }?.takeIf { c -> first.contains(c) } ?: ','
        val rows = ArrayList<List<Cell?>>()
        var row = ArrayList<Cell?>()
        val f = StringBuilder()
        var quoted = false
        var wasQuoted = false
        fun endField() {
            val s = f.toString()
            row.add(if (s.isEmpty()) null else if (!wasQuoted && Regex("""^-?\d+(\.\d+)?$""").matches(s.trim())) Cell.Num(s.trim().toDouble()) else Cell.Text(s))
            f.setLength(0); wasQuoted = false
        }
        var i = 0
        while (i < text.length) {
            val ch = text[i]
            when {
                quoted && ch == '"' && text.getOrNull(i + 1) == '"' -> { f.append('"'); i++ }
                ch == '"' && (quoted || f.isEmpty()) -> { quoted = !quoted; wasQuoted = true }
                quoted -> f.append(ch)
                ch == sep -> endField()
                ch == '\r' -> {}
                ch == '\n' -> { endField(); rows.add(row); row = ArrayList() }
                else -> f.append(ch)
            }
            i++
        }
        if (f.isNotEmpty() || row.isNotEmpty()) { endField(); rows.add(row) }
        return rows
    }

    // ---------------------------------------------------------------- .xlsx
    private val BUILTIN_DATES = (14..22).toSet() + setOf(27, 30, 36, 45, 46, 47, 50, 57)

    fun xlsx(bytes: ByteArray): List<List<List<Cell?>>> {
        val parts = HashMap<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                if (!e.isDirectory && (e.name.endsWith(".xml") || e.name.endsWith(".rels"))) parts[e.name.removePrefix("/")] = z.readBytes()
            }
        }
        val wb = parts["xl/workbook.xml"]?.let(::xml) ?: throw IllegalArgumentException("Not an Excel workbook")
        val rels = parts["xl/_rels/workbook.xml.rels"]?.let(::xml)?.let { d ->
            d.byTag("Relationship").associate { it.getAttribute("Id") to it.getAttribute("Target") }
        }.orEmpty()
        val shared = parts["xl/sharedStrings.xml"]?.let(::xml)?.byTag("si")?.map { si -> si.byTag("t").joinToString("") { it.textContent } }.orEmpty()
        val dateStyles = parts["xl/styles.xml"]?.let(::xml)?.let(::dateStyles).orEmpty()
        return wb.byTag("sheet").mapNotNull { s ->
            // r:id, whatever the prefix is called in this file.
            val id = (0 until s.attributes.length).map { s.attributes.item(it) }.firstOrNull { it.nodeName.endsWith(":id") }?.nodeValue
            val target = rels[id] ?: return@mapNotNull null
            val path = if (target.startsWith("/")) target.removePrefix("/") else "xl/" + target.removePrefix("./")
            parts[path]?.let { rows(xml(it), shared, dateStyles) }
        }
    }

    // The style numbers (s="…" on a cell) whose number format shows a date.
    private fun dateStyles(d: Element): Set<Int> {
        val custom = d.byTag("numFmt").filter { f ->
            val code = f.getAttribute("formatCode").replace(Regex("""\[[^]]*]|"[^"]*"|\\."""), "")
            Regex("[dy]", RegexOption.IGNORE_CASE).containsMatchIn(code) || Regex("m", RegexOption.IGNORE_CASE).containsMatchIn(code) && !Regex("[hs]", RegexOption.IGNORE_CASE).containsMatchIn(code)
        }.map { it.getAttribute("numFmtId").toInt() }.toSet()
        val xfs = d.byTag("cellXfs").firstOrNull()?.childElements("xf").orEmpty()
        return xfs.indices.filter { i -> xfs[i].getAttribute("numFmtId").toIntOrNull()?.let { it in BUILTIN_DATES || it in custom } == true }.toSet()
    }

    private fun rows(d: Element, shared: List<String>, dates: Set<Int>): List<List<Cell?>> {
        val out = ArrayList<List<Cell?>>()
        for (r in d.byTag("row")) {
            val row = ArrayList<Cell?>()
            for (c in r.childElements("c")) {
                val col = column(c.getAttribute("r")) ?: row.size
                while (row.size < col) row.add(null)
                val v = c.childElements("v").firstOrNull()?.textContent
                val cell: Cell? = when (c.getAttribute("t")) {
                    "s" -> v?.toIntOrNull()?.let { shared.getOrNull(it) }?.let { Cell.Text(it) }
                    "inlineStr" -> c.byTag("t").joinToString("") { it.textContent }.takeIf { it.isNotEmpty() }?.let { Cell.Text(it) }
                    "str", "e" -> v?.let { Cell.Text(it) }
                    "b" -> v?.let { Cell.Text(if (it == "1") "true" else "false") }
                    else -> v?.toDoubleOrNull()?.let { n ->
                        if (c.getAttribute("s").toIntOrNull() in dates) Cell.Day(LocalDate.of(1899, 12, 30).plusDays(Math.floor(n + 1e-6).toLong())) else Cell.Num(n)
                    }
                }
                row.add(cell)
            }
            out.add(row)
        }
        return out
    }

    // "C12" -> 2
    private fun column(ref: String): Int? {
        val letters = ref.takeWhile { it.isLetter() }.uppercase()
        if (letters.isEmpty()) return null
        return letters.fold(0) { n, ch -> n * 26 + (ch - 'A' + 1) } - 1
    }

    private fun xml(b: ByteArray): Element = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = false }
        .newDocumentBuilder().parse(ByteArrayInputStream(b)).documentElement

    private fun Element.byTag(tag: String): List<Element> {
        val nl = getElementsByTagName(tag)
        return (0 until nl.length).mapNotNull { nl.item(it) as? Element }
    }

    private fun Element.childElements(tag: String): List<Element> {
        val nl = childNodes
        return (0 until nl.length).mapNotNull { nl.item(it) as? Element }.filter { it.tagName == tag }
    }
}
