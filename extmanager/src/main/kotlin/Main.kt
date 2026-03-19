package moe.grass

import com.googlecode.d2j.dex.Dex2jar
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceFactory
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.util.chapter.ChapterRecognition
import eu.kanade.tachiyomi.util.chapter.ChapterSanitizer.sanitize
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import moe.grass.PackageTools.getPackageInfo
import moe.grass.PackageTools.loadExtensionSources
import suwayomi.tachidesk.server.applicationSetup
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlin.io.path.Path
import kotlin.io.path.exists
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name

const val METADATA_SOURCE_CLASS = "tachiyomi.extension.class"

fun main(args: Array<String>) {
    println("start")

    applicationSetup()

    var sources: List<CatalogueSource> = emptyList()

    embeddedServer(Netty, port = 8000, host = "0.0.0.0") {
        routing {
            get("/sources") {
                val j = Json.encodeToString(sources.map { it.name })
                call.respond(j)
            }
            post("/search") {
                println(call.receiveText())
                sources.forEach {
                    println(it.name)
                    val filters = it.getFilterList()
                    val req = (it as HttpSource).getSearchManga(0, "", filters)
                    req.mangas.map {
                        it.title
                    }
                    val req2 = it.getMangaDetails(req.mangas.get(0))
                    val j = buildJsonObject {
                        put("title", req2.title)
                        put("description", req2.description)
                    }

                    call.respond(Json.encodeToString(j))
                }
            }
            post("/process_extension") {
                val path = Path(call.receiveText())

                val info = getPackageInfo(path.toString())
                val className =
                    info.packageName + info.applicationInfo.metaData.getString(METADATA_SOURCE_CLASS)

                val jar_path = path.resolveSibling(path.name + ".jar")
                if (!jar_path.exists()) {
                    Dex2jar.from(path.toString()).to(jar_path)
                    extractAssetsFromApk(path.toString(), jar_path.toString())
                }

                val extensionMainClassInstance = loadExtensionSources(jar_path.toString(), className)
                val sources =
                    when (extensionMainClassInstance) {
                        is Source -> listOf(extensionMainClassInstance)
                        is SourceFactory -> extensionMainClassInstance.createSources()
                        else -> throw RuntimeException("Unknown source class type! ${extensionMainClassInstance.javaClass}")
                    }
                        .map { it as CatalogueSource }
                        .map {
                            buildJsonObject {
                                put("id", it.id)
                                put("name", it.name)
                                put("lang", it.lang)
                            }
                        }

//                val j = buildJsonObject {
//                    put("name", req2.title)
//                    put("description", req2.description)
//                }
                call.respond(Json.encodeToString(sources))
            }
        }
    }.start(wait = true)
}

private fun extractAssetsFromApk(
    apkPath: String,
    jarPath: String,
) {
    val apkFile = File(apkPath)
    val jarFile = File(jarPath)

    val assetsFolder = File("${apkFile.parent}/${apkFile.nameWithoutExtension}_assets")
    assetsFolder.mkdir()
    ZipInputStream(apkFile.inputStream()).use { zipInputStream ->
        var zipEntry = zipInputStream.nextEntry
        while (zipEntry != null) {
            if (zipEntry.name.startsWith("assets/") && !zipEntry.isDirectory) {
                val assetFile = File(assetsFolder, zipEntry.name)
                assetFile.parentFile.mkdirs()
                FileOutputStream(assetFile).use { outputStream ->
                    zipInputStream.copyTo(outputStream)
                }
            }
            zipEntry = zipInputStream.nextEntry
        }
    }

    val tempJarFile = File("${jarFile.parent}/${jarFile.nameWithoutExtension}_temp.jar")
    ZipInputStream(jarFile.inputStream()).use { jarZipInputStream ->
        ZipOutputStream(FileOutputStream(tempJarFile)).use { jarZipOutputStream ->
            var zipEntry = jarZipInputStream.nextEntry
            while (zipEntry != null) {
                if (!zipEntry.name.startsWith("META-INF/")) {
                    jarZipOutputStream.putNextEntry(ZipEntry(zipEntry.name))
                    jarZipInputStream.copyTo(jarZipOutputStream)
                }
                zipEntry = jarZipInputStream.nextEntry
            }
            assetsFolder.walkTopDown().forEach { file ->
                if (file.isFile) {
                    jarZipOutputStream.putNextEntry(
                        ZipEntry(
                            file.relativeTo(assetsFolder).toString().replace("\\", "/")
                        )
                    )
                    file.inputStream().use { inputStream ->
                        inputStream.copyTo(jarZipOutputStream)
                    }
                    jarZipOutputStream.closeEntry()
                }
            }
        }
    }

    jarFile.delete()
    tempJarFile.renameTo(jarFile)

    assetsFolder.deleteRecursively()
}

suspend fun fetchChapterList(source: CatalogueSource, manga: SManga): List<SChapter> {
    val chapters = source.getChapterList(manga).distinctBy { it.url }

    // Recognize number for new chapters.
    chapters.forEach { chapter ->
        (source as? HttpSource)?.prepareNewChapter(chapter, manga)
        val chapterNumber = ChapterRecognition.parseChapterNumber(
            manga.title,
            chapter.name,
            chapter.chapter_number.toDouble()
        )
        chapter.chapter_number = chapterNumber.toFloat()
        chapter.name = chapter.name.sanitize(manga.title)
        chapter.scanlator = chapter.scanlator?.ifBlank { null }?.trim()
    }

    return chapters
}