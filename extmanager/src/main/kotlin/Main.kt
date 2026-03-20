package moe.grass

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
import kotlinx.coroutines.future.await
import kotlinx.coroutines.future.future
import kotlinx.serialization.json.*
import suwayomi.tachidesk.manga.impl.util.PackageTools
import suwayomi.tachidesk.manga.impl.util.PackageTools.getPackageInfo
import suwayomi.tachidesk.manga.impl.util.PackageTools.loadExtensionSources
import suwayomi.tachidesk.server.applicationSetup
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlin.io.path.Path
import kotlin.io.path.exists
import kotlin.io.path.name

const val METADATA_SOURCE_CLASS = "tachiyomi.extension.class"

fun main() {
    println("start")

    applicationSetup()

    var extensions: MutableMap<String, Map<Long, CatalogueSource>> = mutableMapOf()

    embeddedServer(Netty, port = 8000, host = "0.0.0.0") {
        routing {
            post("/process_extension") {
                val path = Path(call.receiveText())

                val sources = get_sources(path)
                    .map {
                        buildJsonObject {
                            put("id", it.id)
                            put("name", it.name)
                            put("lang", it.lang)
                        }
                    }

                call.respond(Json.encodeToString(sources))
            }

            post("/search") {
                val resp = future {
                    val el = Json.parseToJsonElement(call.receiveText()).jsonObject

                    val page = el["page"]?.jsonPrimitive?.int ?: 1
                    val query = el["query"]?.jsonPrimitive?.content ?: ""
                    val extension = el["extension"]?.jsonPrimitive?.content ?: ""
                    val source_id = el["source"]?.jsonPrimitive?.long ?: 0L

                    if (extension == "" || source_id == 0L) {
                        return@future buildJsonObject {}
                    }

                    if (!extensions.containsKey(extension)) {
                        val sources: Map<Long, CatalogueSource> =
                            get_sources(Path(extension)).map { it.id to it }.toMap()
                        extensions[extension] = sources
                    }

                    val source = extensions[extension]?.get(source_id)
                    if (source == null || source.id != source_id) {
                        return@future buildJsonObject {}
                    }

                    println("search with " + source.name + " " + source.lang)
                    try {
                        val search = source.getSearchManga(page, query, source.getFilterList())
                        return@future buildJsonObject {
                            put("results", buildJsonArray {
                                search.mangas.forEach {
                                    add(buildJsonObject {
                                        put("url", it.url)
                                        put("title", it.title)
                                        put("artist", it.artist)
                                        put("author", it.author)
                                        put("description", it.description)
                                        put("genre", it.genre)
                                        put("status", it.status)
                                        put("thumbnail_url", it.thumbnail_url)
                                    })
                                }
                            })
                        }
                    } catch (e: Exception) {
                        e.printStackTrace()
                        return@future buildJsonObject {}
                    }

                    return@future buildJsonObject {}
                }.await()

                call.respond(Json.encodeToString(resp))
            }

            post("/get_details") {
                val resp = future {
                    val el = Json.parseToJsonElement(call.receiveText()).jsonObject

                    val extension = el["extension"]?.jsonPrimitive?.content ?: ""
                    val source_id = el["source"]?.jsonPrimitive?.long ?: 0L
                    val title = el["title"]?.jsonPrimitive?.content ?: ""
                    val url = el["url"]?.jsonPrimitive?.content ?: ""

                    if (extension == "" || source_id == 0L) {
                        return@future buildJsonObject {}
                    }

                    if (!extensions.containsKey(extension)) {
                        val sources: Map<Long, CatalogueSource> =
                            get_sources(Path(extension)).map { it.id to it }.toMap()
                        extensions[extension] = sources
                    }

                    val source = extensions[extension]?.get(source_id)
                    if (source == null || source.id != source_id) {
                        return@future buildJsonObject {}
                    }

                    val smanga = SManga.create().apply {
                        this.title = title
                        this.url = url
                    }

                    try {
                        val req = source.getMangaDetails(smanga)
                        buildJsonObject {
                            put("title", req.title)
                            put("artist", req.artist)
                            put("author", req.author)
                            put("description", req.description)
                            put("genre", req.genre)
                            put("status", req.status)
                            put("thumbnail_url", req.thumbnail_url)
                        }
                    } catch (e: Exception) {
                        e.printStackTrace()
                        return@future buildJsonObject {}
                    }
                }.await()

                call.respond(Json.encodeToString(resp))
            }

            post("/filters") {
                val el = Json.parseToJsonElement(call.receiveText()).jsonObject

                val extension = el["extension"]?.jsonPrimitive?.content ?: ""
                val source_id = el["source"]?.jsonPrimitive?.long ?: 0L

                if (extension != "" && source_id != 0L) {
                    if (!extensions.containsKey(extension)) {
                        val sources: Map<Long, CatalogueSource> =
                            get_sources(Path(extension)).map { it.id to it }.toMap()
                        extensions[extension] = sources
                    }

                    extensions[extension]?.let {
                        it[source_id]?.let { source ->
                            call.respond(Json.encodeToString(source.getFilterList()))
                        }
                    }
                }
            }
        }
    }.start(wait = true)
}

private fun get_sources(path: Path): List<CatalogueSource> {
    val info = getPackageInfo(path.toString())
    val className =
        info.packageName + info.applicationInfo.metaData.getString(METADATA_SOURCE_CLASS)

    val jar_path = path.resolveSibling(path.name + ".jar")
    if (!jar_path.exists()) {
        PackageTools.dex2jar(path.toString(), jar_path.toString())
        extractAssetsFromApk(path.toString(), jar_path.toString())
    }

    val extensionMainClassInstance = loadExtensionSources(jar_path.toString(), className)
    val sources =
        when (extensionMainClassInstance) {
            is Source -> listOf(extensionMainClassInstance)
            is SourceFactory -> extensionMainClassInstance.createSources()
            else -> throw RuntimeException("Unknown source class type! ${extensionMainClassInstance.javaClass}")
        }

    return sources.map { it as CatalogueSource }
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