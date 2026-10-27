plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP 9 compiles Kotlin itself; this only picks a newer Kotlin than the one it ships with.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}
