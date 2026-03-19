package xyz.nulldev.androidcompat.info

import android.content.pm.ApplicationInfo
import xyz.nulldev.ts.config.ConfigManager

class ApplicationInfoImpl(
    private val configManager: ConfigManager,
) : ApplicationInfo() {
    val debug: Boolean get() = true

    init {
        super.packageName = "eu.kanade.tachiyomi"
    }
}
