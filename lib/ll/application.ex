defmodule LL.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      LL.Repo,
      LLWeb.Telemetry,
      {Phoenix.PubSub, name: LL.PubSub},
      LLWeb.Endpoint,
      LL.ExtensionManager,
      LL.SourceManager,
      LL.Status,
      Supervisor.child_spec({LL.WorkerManager, name: :downloader},
        id: :downloader
      ),
      Supervisor.child_spec({LL.WorkerManager, name: :local},
        id: :local
      ),
      Supervisor.child_spec(
        {LL.Timer,
         id: :sync,
         fun: &LL.sync_chapters/0,
         interval: Application.fetch_env!(:ll, :sync_interval)},
        id: LL.TimerSync
      )
    ]

    downloaders =
      Enum.map(
        1..1,
        &Supervisor.child_spec({LL.Downloader, id: "downloader.#{&1}", queue: :downloader},
          id: "LL.Downloader.downloader.#{&1}"
        )
      )

    downloaders2 =
      Enum.map(
        1..5,
        &Supervisor.child_spec({LL.Downloader, id: "local.#{&1}", queue: :local},
          id: "LL.Downloader.local.#{&1}"
        )
      )

    children = children ++ downloaders ++ downloaders2

    LL.Source.start_bucket()

    opts = [strategy: :one_for_one, name: LL.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    LLWeb.Endpoint.config_change(changed, removed)
    :ok
  end
end
