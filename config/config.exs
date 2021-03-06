# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :ll,
  get_all_pages: false,
  n_downloaders: 4,
  n_encoders: 4,
  ecto_repos: [LL.Repo],
  files_root: "/tank/llm/",
  sync_interval: 7_200_000,
  encode_interval: 3_600_000

# Configures the endpoint
config :ll, LLWeb.Endpoint,
  url: [host: "m.grass.moe"],
  render_errors: [view: LLWeb.ErrorView, accepts: ~w(html json), layout: false],
  pubsub_server: LL.PubSub,
  live_view: [signing_salt: "fNgamUF+"]

# Configure esbuild (the version is required)
config :esbuild,
  version: "0.14.0",
  default: [
    args:
      ~w(js/app.js --bundle --target=es2017 --outdir=../priv/static/assets --external:/fonts/* --external:/images/*),
    cd: Path.expand("../assets", __DIR__),
    env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}
  ]

config :dart_sass,
  version: "1.39.0",
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
