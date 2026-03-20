package suwayomi.tachidesk.server

/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import com.typesafe.config.Config
import kotlinx.coroutines.flow.MutableStateFlow
import xyz.nulldev.ts.config.GlobalConfigManager
import xyz.nulldev.ts.config.SystemPropertyOverridableConfigModule
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

const val SERVER_CONFIG_MODULE_NAME = "server"

val serverConfig: ServerConfig by lazy { GlobalConfigManager.module() }

// Settings are ordered by "protoNumber".
class ServerConfig(
    getConfig: () -> Config,
) : SystemPropertyOverridableConfigModule(
    getConfig,
    SERVER_CONFIG_MODULE_NAME,
) {
    val downloadAsCbz = false

    val flareSolverrEnabled: MutableStateFlow<Boolean> = MutableStateFlow(true)

    val flareSolverrUrl: MutableStateFlow<String> = MutableStateFlow("http://localhost:8191")

    val flareSolverrTimeout: MutableStateFlow<Int> = MutableStateFlow(60.seconds.inWholeSeconds.toInt())

    val flareSolverrSessionName: MutableStateFlow<String> = MutableStateFlow("suwayomi")

    val flareSolverrSessionTtl: MutableStateFlow<Int> = MutableStateFlow(15.minutes.inWholeMinutes.toInt())

    val flareSolverrAsResponseFallback: MutableStateFlow<Boolean> = MutableStateFlow(false)

    val useHikariConnectionPool: MutableStateFlow<Boolean> = MutableStateFlow(true)
}
