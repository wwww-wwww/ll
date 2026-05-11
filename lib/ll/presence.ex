defmodule LL.Presence do
  use Phoenix.Presence,
    otp_app: :ll,
    pubsub_server: LL.PubSub
end
