import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile
import org.jlleitschuh.gradle.ktlint.KtlintPlugin

plugins {
    application
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.ktor)
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ktlint) apply false
    alias(libs.plugins.download) apply false
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.moko) apply false
    alias(libs.plugins.jte) apply false
}

group = "moe.grass"
version = "1.0-SNAPSHOT"

application {
    mainClass.set("moe.grass.MainKt")
}

allprojects {
    repositories {
        mavenCentral()
        google()
        maven("https://github.com/Suwayomi/Suwayomi-Server/raw/android-jar/")
        maven("https://jitpack.io")
        maven("https://jogamp.org/deployment/maven")
    }
}

dependencies {
    implementation(libs.bundles.shared)
    implementation(libs.ktor.server.core)
    implementation(libs.ktor.server.netty)
    implementation(libs.asm)
    implementation(libs.dex2jar.translator)
    implementation(libs.dex2jar.tools)
    implementation(libs.apk.parser)
    implementation(libs.apksig)
    implementation(libs.android.annotations)

    implementation(projects.androidCompat)
    implementation(projects.androidCompat.config)
//    implementation(projects.server.serverConfig)

    // OkHttp
    implementation(libs.bundles.okhttp)
    implementation(libs.okio)

    // Javalin api
    implementation(libs.bundles.javalin)
    implementation(libs.bundles.jackson)

    // GraphQL
    implementation(libs.graphql.kotlin.server)
    implementation(libs.graphql.kotlin.scheme)
    implementation(libs.graphql.java.scalars)

    // Exposed ORM
    implementation(libs.bundles.exposed)
    implementation(libs.postgres)
    implementation(libs.h2)
    implementation(libs.hikaricp)

    // Exposed Migrations
    implementation(libs.exposed.migrations)

    // tray icon
    implementation(libs.bundles.systemtray)

    // dependencies of Mihon (Tachiyomi) extensions, some are duplicate, keeping it here for reference
    implementation(libs.injekt)
    implementation(libs.okhttp.core)
    implementation(libs.rxjava)
    implementation(libs.jsoup)

    // ComicInfo
    implementation(libs.serialization.xml.core)
    implementation(libs.serialization.xml)

    // Sort
    implementation(libs.sort)

    // asm for ByteCodeEditor(fixing SimpleDateFormat) (must match Dex2Jar version)
    implementation(libs.asm)

    // Disk & File
    implementation(libs.cache4k)
    implementation(libs.zip4j)
    implementation(libs.commonscompress)
    implementation(libs.junrar)

    // AES/CBC/PKCS7Padding Cypher provider for zh.copymanga
    implementation(libs.bouncycastle)
}

kotlin {
    jvmToolchain(25)
}

subprojects {
    plugins.withType<JavaPlugin> {
        extensions.configure<JavaPluginExtension> {
            val javaVersion = JavaVersion.toVersion(libs.versions.jvmTarget.get())
            sourceCompatibility = javaVersion
            targetCompatibility = javaVersion
        }
    }

    tasks {
        withType<KotlinJvmCompile> {
            if (plugins.hasPlugin(KtlintPlugin::class)) {
                dependsOn("ktlintFormat")
            }
            compilerOptions {
                jvmTarget = JvmTarget.fromTarget(libs.versions.jvmTarget.get())
                freeCompilerArgs.add("-Xcontext-receivers")
            }
        }
    }
}

tasks {
    shadowJar {
        isZip64 = true
        manifest {
            attributes("Main-Class" to "moe.grass.MainKt")
        }

        archiveBaseName.set(rootProject.name)
        archiveClassifier.set("")

        mergeServiceFiles()
    }

    withType<KotlinJvmCompile> {
        compilerOptions {
            freeCompilerArgs.add(
                "-opt-in=kotlinx.serialization.ExperimentalSerializationApi",
            )
        }
    }
    compileKotlin {
        dependsOn(":server:server-config-generate:generateSettings")
    }

    processResources {
        dependsOn(":server:server-config-generate:generateSettings")
    }

    processTestResources {
        dependsOn(":server:server-config-generate:generateSettings")
    }
}
