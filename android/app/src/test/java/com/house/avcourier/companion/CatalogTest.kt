package com.house.avcourier.companion

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's offline search must give the PC's answers. catalog-fixture.ndjson is what
 * the PC sends to the phone for a small made-up catalogue; catalog-expected.json holds the
 * PC's own results for the same searches (both written by tests/phone-fixture.js).
 */
class CatalogTest {
    private fun resource(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader()

    private val catalog by lazy { resource("catalog-fixture.ndjson").use { Catalog.read(it) } }

    @Test
    fun readsWhatThePcSends() {
        assertEquals(21, catalog.rows.size)
        assertEquals(listOf("raw", "episode"), catalog.sheets.map { it.kind })
        val row = catalog.rows.first { it.id == "DD-F-4K-3046-E" }
        assertEquals(listOf("Vatsalya" to "", "Amba Video" to "", "HDD" to "", "Disaster Recovery" to ""), catalog.backups(row))
        assertEquals("DD Formal HD/4K", catalog.heading(row))
        assertEquals("• General Satsang (General), Hong Kong, 9 Oct 2026 · Folder 3046 · DD-F-4K-3046-E\n   not on any backup yet", catalog.line(row))
    }

    @Test
    fun sameResultsAsThePc() {
        val expected = JSONArray(resource("catalog-expected.json").use { it.readText() })
        for (i in 0 until expected.length()) {
            val case = expected.getJSONObject(i)
            val q = case.getString("q")
            val got = if (case.getString("mode") == "request") catalog.forRequest(q) else catalog.search(q, limit = 100)
            val want = case.getJSONArray("results")
            val wantRows = (0 until want.length()).map { j ->
                val r = want.getJSONObject(j)
                val why = r.getJSONArray("why")
                Triple(r.getString("id"), r.getInt("score"), (0 until why.length()).map { why.getString(it) })
            }
            assertEquals("“$q”", wantRows, got.map { Triple(it.row.id, it.score, it.why) })
        }
    }

    @Test
    fun aNamedFolderThatIsNotThereGivesNothing() {
        assertTrue(catalog.forRequest("Need raw folder 3099 for making prachaar video").isEmpty())
        assertEquals(listOf("DD-F-4K-3046-E"), catalog.forRequest("Raw data requirement\n\nNeed raw folder 3046 for making prachaar video").map { it.row.id })
    }
}
