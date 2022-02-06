defmodule LL.Repo do
  use Ecto.Repo,
    otp_app: :ll,
    adapter: Ecto.Adapters.Postgres
end
