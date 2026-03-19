rootProject.name = "extmanager"

include("AndroidCompat")
include("AndroidCompat:Config")

include("server")
include("server:server-config")
include("server:server-config-generate")

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")
