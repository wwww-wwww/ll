package suwayomi.tachidesk.server

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import android.os.Looper
import ch.qos.logback.classic.Level
import dev.datlag.kcef.KCEF
import dev.datlag.kcef.KCEFBuilder.Settings.LogSeverity
import eu.kanade.tachiyomi.App
import eu.kanade.tachiyomi.createAppModule
import eu.kanade.tachiyomi.network.NetworkHelper
import io.github.oshai.kotlinlogging.KotlinLogging
import io.javalin.json.JavalinJackson
import io.javalin.json.JsonMapper
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.koin.core.context.startKoin
import org.koin.core.module.Module
import org.koin.dsl.module
import suwayomi.tachidesk.manga.impl.util.lang.renameTo
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get
import xyz.nulldev.androidcompat.AndroidCompat
import xyz.nulldev.androidcompat.AndroidCompatInitializer
import xyz.nulldev.androidcompat.androidCompatModule
import xyz.nulldev.ts.config.ApplicationRootDir
import xyz.nulldev.ts.config.configManagerModule
import xyz.nulldev.ts.config.setLogLevelFor
import java.io.File
import java.security.Security
import java.util.*
import kotlin.concurrent.thread
import kotlin.io.path.Path
import kotlin.io.path.createDirectories
import kotlin.io.path.div
import kotlin.math.roundToInt

private val logger = KotlinLogging.logger {}

class ApplicationDirs(
    val dataRoot: String = ApplicationRootDir,
    val tempRoot: String = "${System.getProperty("java.io.tmpdir")}/Tachidesk",
) {
    val extensionsRoot = "$dataRoot/extensions"
    val downloadsRoot
        get() = "$dataRoot/downloads"
    val localMangaRoot
        get() = "$dataRoot/local"
    val webUIRoot = "$dataRoot/webUI"
    val webUIServe = "$tempRoot/webUI-serve"

    val tempThumbnailCacheRoot = "$tempRoot/thumbnails"
    val tempMangaCacheRoot = "$tempRoot/manga-cache"

    val thumbnailDownloadsRoot
        get() = "$downloadsRoot/thumbnails"
    val mangaDownloadsRoot
        get() = "$downloadsRoot/mangas"
}

@Suppress("DEPRECATION")
class LooperThread : Thread() {
    override fun run() {
        logger.info { "Starting Android Main Loop" }
        Looper.prepareMainLooper()
        Looper.loop()
    }
}

val androidCompat by lazy { AndroidCompat() }

fun serverModule(applicationDirs: ApplicationDirs): Module =
    module {
        single { applicationDirs }
        single<JsonMapper> { JavalinJackson() }
    }

@OptIn(DelicateCoroutinesApi::class)
fun applicationSetup() {
    Thread.setDefaultUncaughtExceptionHandler { _, throwable ->
        KotlinLogging.logger {}.error(throwable) { "unhandled exception" }
    }

    val mainLoop = LooperThread()
    mainLoop.start()

    // Application dirs
    val applicationDirs = ApplicationDirs()

    logger.info { "Running Suwayomi-Server " }

    logger.debug { "Data Root directory is set to: ${applicationDirs.dataRoot}" }

    // Migrate Directories from old versions
    File("$ApplicationRootDir/manga-thumbnails").renameTo(applicationDirs.tempThumbnailCacheRoot)
    File("$ApplicationRootDir/manga-local").renameTo(applicationDirs.localMangaRoot)
    File("$ApplicationRootDir/anime-thumbnails").delete()

    // make dirs we need
    listOf(
        applicationDirs.dataRoot,
        applicationDirs.extensionsRoot,
        applicationDirs.extensionsRoot + "/icon",
        applicationDirs.tempThumbnailCacheRoot,
        applicationDirs.downloadsRoot,
        applicationDirs.localMangaRoot,
    ).forEach { File(it).mkdirs() }

    // initialize Koin modules
    val app = App()
    startKoin {
        modules(
            createAppModule(app),
            androidCompatModule(),
            configManagerModule(),
            serverModule(applicationDirs),
        )
    }

    // Load Android compatibility dependencies
    AndroidCompatInitializer().init()
    // start app
    androidCompat.startApp(app)

    // Initialize NetworkHelper early
    Injekt
        .get<NetworkHelper>()
        .userAgentFlow
        .onEach { System.setProperty("http.agent", it) }
        .launchIn(GlobalScope)

    // fixes #119 , ref:
    // https://github.com/Suwayomi/Suwayomi-Server/issues/119#issuecomment-894681292 , source Id
    // calculation depends on String.lowercase()
    Locale.setDefault(Locale.ENGLISH)

    setLogLevelFor("org.eclipse.jetty", Level.OFF)
    setLogLevelFor("com.zaxxer.hikari", Level.WARN)

    // AES/CBC/PKCS7Padding Cypher provider for zh.copymanga
    Security.addProvider(BouncyCastleProvider())

    GlobalScope.launch {
        val logger = KotlinLogging.logger("KCEF")
        KCEF.init(
            builder = {
                progress {
                    var lastNum = -1
                    onDownloading {
                        val num = it.roundToInt()
                        if (num > lastNum) {
                            lastNum = num
                            logger.info { "KCEF download progress: $num%" }
                        }
                    }
                }
                download { github() }
                settings {
                    windowlessRenderingEnabled = true
                    cachePath = (Path(applicationDirs.dataRoot) / "cache/kcef").toString()
                    logSeverity = LogSeverity.Default
                }
                appHandler(
                    KCEF.AppHandler(
                        arrayOf(
                            "--disable-gpu",
                            // #1486 needed to be able to render without a window
                            "--off-screen-rendering-enabled",
                            // #1489 since /dev/shm is restricted in docker (OOM)
                            "--disable-dev-shm-usage",
                            // #1723 support Widevine (incomplete)
                            "--enable-widevine-cdm",
                            // #1736 JCEF does implement stack guards properly
                            "--change-stack-guard-on-fork=disable",
                        ),
                    ),
                )

                val kcefDir = Path(applicationDirs.dataRoot) / "bin/kcef"
                kcefDir.createDirectories()
                installDir(kcefDir.toFile())
            },
            onError = { it?.printStackTrace() },
        )
    }

    Runtime.getRuntime().addShutdownHook(
        thread(start = false) {
            val logger = KotlinLogging.logger("KCEF")
            logger.debug { "Shutting down KCEF" }
            KCEF.disposeBlocking()
            logger.debug { "KCEF shutdown complete" }
        },
    )
}
