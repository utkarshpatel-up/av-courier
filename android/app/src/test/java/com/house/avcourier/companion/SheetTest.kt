package com.house.avcourier.companion

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same spreadsheets as tests/sheet-fixture.js: the phone must read the lines the PC reads. */
class SheetTest {
    private fun res(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.use { it.readBytes() }
    private val expected = JSONObject(String(res("sheet-expected.json")))

    @Test fun readsLikeThePc() {
        for (name in listOf("sheet-shared.xlsx", "sheet-inline.xlsx", "sheet-list.csv")) {
            assertEquals(name, expected.getString(name), Sheet.read(res(name), name).text)
        }
    }

    @Test fun eachRowIsAnItem() {
        val r = Sheet.read(res("sheet-shared.xlsx"), "sheet-shared.xlsx")
        assertEquals(6, r.rows)
        val items = Heuristic.items("Please send these\n\n" + r.text)
        assertEquals(6, items.size)
        assertTrue(items[1].startsWith("Sr: 2 · Raw Video Id: DD-F-HD-1260-E1"))
    }

    @Test fun whichFilesAreReadHere() {
        assertTrue(Sheet.readsOnPhone("a.xlsx"))
        assertTrue(Sheet.readsOnPhone("b.CSV"))
        assertFalse(Sheet.readsOnPhone("old.xls"))
        assertFalse(Sheet.readsOnPhone("c.ods"))
        assertTrue(Sheet.isSheet("old.xls"))
        assertTrue(Sheet.isSheet("x", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
        assertFalse(Sheet.isSheet("photo.jpg", "image/jpeg"))
    }

    @Test fun tabsAndSemicolons() {
        assertEquals("• Event: Garba · Folder: 3050", Sheet.read("Event\tFolder\nGarba\t3050\n".toByteArray(), "x.tsv").text)
        assertEquals("• Event: Garba · Folder: 3050", Sheet.read("Event;Folder\r\nGarba;3050\r\n".toByteArray(), "x.csv").text)
    }
}
