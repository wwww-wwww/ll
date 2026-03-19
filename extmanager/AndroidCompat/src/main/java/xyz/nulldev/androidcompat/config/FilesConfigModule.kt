package xyz.nulldev.androidcompat.config

import com.typesafe.config.Config
import xyz.nulldev.ts.config.ConfigModule

/**
 * Files configuration modules. Specifies where to store the Android files.
 */

class FilesConfigModule(
)  {
    val dataDir: String = "androidcompat-root/data"
    val filesDir: String = "androidcompat-root/files"
    val noBackupFilesDir: String = "androidcompat-root/no_backup"
    val externalFilesDirs: String = "androidcompat-root/extappdata/files"
    val obbDirs: String = "androidcompat-root/extappdata/obb"
    val cacheDir: String = "androidcompat-root/cache"
    val codeCacheDir: String = "androidcompat-root/code_cache"
    val externalCacheDirs: String = "androidcompat-root/extappdata/cache"
    val externalMediaDirs: String = "androidcompat-root/extappdata/media"
    val rootDir: String = "androidcompat-root/appdata"
    val externalStorageDir: String = "androidcompat-root/extappdata"
    val downloadCacheDir: String = "androidcompat-root/extappdata/downloadCache"
    val databasesDir: String = "androidcompat-root/databases"

    val prefsDir: String = "androidcompat-root/shared_prefs"

    val packageDir: String = "androidcompat-root/android-compat/packages"
}
