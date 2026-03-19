package xyz.nulldev.androidcompat

import android.webkit.WebView
import xyz.nulldev.androidcompat.webkit.KcefWebViewProvider

/**
 * Initializes the Android compatibility module
 */
class AndroidCompatInitializer {
    fun init() {
        // Register config modules
//        GlobalConfigManager.registerModules(
//            FilesConfigModule.register(GlobalConfigManager.config),
//            ApplicationInfoConfigModule.register(GlobalConfigManager.config),
//            SystemConfigModule.register(GlobalConfigManager.config),
//        )

        WebView.setProviderFactory({ view: WebView -> KcefWebViewProvider(view) })

        // Set some properties extensions use
        System.setProperty(
            "http.agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        )
    }
}
