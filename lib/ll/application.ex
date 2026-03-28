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
      # Supervisor.child_spec({LL.WorkerManager, name: LL.CriticalQueue},
      #  id: LL.CriticalQueue
      # ),
      # LL.CriticalWriter,
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
      # Supervisor.child_spec(
      #  {LL.Timer,
      #   id: :encode,
      #   fun: &LL.encode_missing/0,
      #   interval: Application.fetch_env!(:ll, :encode_interval)},
      #  id: LL.TimerEncoode
      # )
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

    # encoders =
    #   1..Application.fetch_env!(:ll, :n_encoders)
    #   |> Enum.map(&Supervisor.child_spec({LL.Encoder, id: &1}, id: "LL.Encoder#{&1}"))

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

defmodule LL.CriticalWriter do
  use GenServer

  alias LL.{WorkerManager, CriticalQueue}

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(_opts) do
    send(self(), :startup)
    {:ok, %{}}
  end

  def handle_info(:startup, state) do
    GenServer.call(CriticalQueue, {:register, self()})

    {:noreply, state}
  end

  def handle_cast(:loop, state) do
    case WorkerManager.pop(CriticalQueue, false) do
      :empty ->
        nil

      cb ->
        cb.()

        GenServer.cast(self(), :loop)
    end

    {:noreply, state}
  end

  def get() do
    WorkerManager.get(CriticalQueue)
  end

  def add(cb) do
    WorkerManager.add(CriticalQueue, cb, false)
  end
end
