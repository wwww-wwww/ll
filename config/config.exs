# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :ll,
  get_all_pages: false,
  n_downloaders: 1,
  ecto_repos: [LL.Repo],
  sync_interval: 21_600_000,
  downloads_root: "/tank/yuriyomi",
  encode_interval: 3_600_000

# Configures the endpoint
config :ll, LLWeb.Endpoint,
  url: [host: "yuri.grass.moe"],
  render_errors: [view: LLWeb.ErrorView, accepts: ~w(html json), layout: false],
  pubsub_server: LL.PubSub,
  live_view: [signing_salt: "fNgamUF+"]

# Configure esbuild (the version is required)
config :esbuild,
  version: "0.27.4",
  default: [
    args:
      ~w(js/app.js --bundle --target=es2022 --outdir=../priv/static/assets --external:/fonts/* --external:/images/* --alias:@=. --loader:.wgsl=text),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => [Path.expand("../deps", __DIR__), Mix.Project.build_path()]}
  ]

config :phoenix_live_view, :colocated_js,
  target_directory: Path.expand("../assets/node_modules/phoenix-colocated", __DIR__)

config :dart_sass,
  version: "1.99.0",
  default: [
    args: ~w(css/app.scss ../priv/static/assets/app.css),
    cd: Path.expand("../assets", __DIR__)
  ]

# Configures Elixir's Logger
config :logger, :console,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id],
  level: :info

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
