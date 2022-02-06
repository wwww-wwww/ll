defmodule LL.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    {cjxl_ver, 0} = System.cmd("wsl", ["-e", "cjxl", "-V"])
    cjxl_ver = cjxl_ver |> String.split("\n") |> Enum.at(0)
    Application.put_env(:ll, :cjxl, cjxl_ver)

    children = [
      LL.Repo,
      LLWeb.Telemetry,
      {Phoenix.PubSub, name: LL.PubSub},
      LLWeb.Endpoint,
      LL.DB,
      LL.Status,
      LL.Sources,
      Supervisor.child_spec({LL.WorkerManager, name: LL.CriticalQueue},
        id: LL.CriticalQueue
      ),
      LL.CriticalWriter,
      Supervisor.child_spec({LL.WorkerManager, name: LL.DownloaderManager},
        id: LL.DownloaderManager
      ),
      Supervisor.child_spec({LL.WorkerManager, name: LL.EncoderManager},
        id: LL.EncoderManager
      )
    ]

    downloaders =
      1..Application.fetch_env!(:ll, :n_downloaders)
      |> Enum.map(
        &Supervisor.child_spec({LL.Downloader, id: &1}, id: "LL.Downloader#{&1}")
      )

    encoders =
      1..Application.fetch_env!(:ll, :n_encoders)
      |> Enum.map(
        &Supervisor.child_spec({LL.Encoder, id: &1}, id: "LL.Encoder#{&1}")
      )

    children = children ++ downloaders ++ encoders

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

defmodule LL.WorkerManager do
  use GenServer

  alias LL.Status

  defstruct workers: [], queue: :queue.new(), name: nil

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: opts[:name])
  end

  def init(opts) do
    {:ok, %__MODULE__{name: to_string(opts[:name]) |> String.split(".") |> Enum.take(-1)}}
  end

  def handle_call(:get, _from, state) do
    {:reply, state, state}
  end

  def handle_call(:pop, _from, state) do
    case :queue.out(state.queue) do
      {{:value, head}, queue} ->
        Status.put(state.name, "#{:queue.len(queue)} items in queue")
        {:reply, head, %{state | queue: queue}}

      {:empty, _queue} ->
        {:reply, :empty, state}
    end
  end

  def handle_call({:register, pid}, _from, state) do
    {:reply, :ok, %{state | workers: state.workers ++ [pid]}}
  end

  def handle_cast({:add, element}, state) do
    Enum.each(state.workers, &GenServer.cast(&1, :loop))

    queue = :queue.in(element, state.queue)
    Status.put(state.name, "#{:queue.len(queue)} items in queue")

    {:noreply, %{state | queue: queue}}
  end

  def handle_cast({:add_all, elements}, state) do
    Enum.each(state.workers, &GenServer.cast(&1, :loop))

    queue = Enum.reduce(elements, state.queue, &:queue.in(&1, &2))

    Status.put(state.name, "#{:queue.len(queue)} items in queue")

    {:noreply, %{state | queue: queue}}
  end

  def get(pid) do
    GenServer.call(pid, :get)
  end

  def pop(pid) do
    GenServer.call(pid, :pop)
  end

  def add(pid, element) do
    GenServer.cast(pid, {:add, element})
  end

  def add_all(pid, elements) do
    GenServer.cast(pid, {:add_all, elements})
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
    case WorkerManager.pop(CriticalQueue) do
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
    WorkerManager.add(CriticalQueue, cb)
  end
end