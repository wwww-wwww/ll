import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# Start the phoenix server if environment is set and running in a release
if System.get_env("PHX_SERVER") && System.get_env("RELEASE_NAME") do
  config :ll, LLWeb.Endpoint, server: true
end

if config_env() == :prod do
  config :ll, LL.Repo,
    username: "w",
    password: "w",
    hostname: "localhost",
    database: "mg",
    pool_size: 10

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.

  config :ll, LLWeb.Endpoint,
    http: [ip: {0, 0, 0, 0}, port: 5002],
    url: [host: "m.grass.moe", port: 443],
    secret_key_base: "/Mfsbj4r4L34AavA5oW1p7B+BejCx6GclATApmzNtZ9SorLR6QW7go4huiAnp9OS",
    cache_static_manifest: "priv/static/cache_manifest.json"

  # ## Using releases
  #
  # If you are doing OTP releases, you need to instruct Phoenix
  # to start each relevant endpoint:
  #
  #     config :ll, LLWeb.Endpoint, server: true
  #
  # Then you can assemble a release by calling `mix release`.
  # See `mix help release` for more information.
end
