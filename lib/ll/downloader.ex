defmodule LL.Downloader do
  use GenServer

  alias LL.{WorkerManager, DownloaderManager, Status}

  @tmp_dir "tmp"

  defstruct id: nil, active: false

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: String.to_atom("#{__MODULE__}_#{opts[:id]}"))
  end

  def init(opts) do
    send(self(), :startup)
    {:ok, %__MODULE__{id: {__MODULE__, opts[:id]}}}
  end

  def handle_info(:startup, state) do
    GenServer.call(DownloaderManager, {:register, self()})
    Status.put(state.id, "Idle")

    GenServer.cast(self(), :loop)
    {:noreply, state}
  end

  def handle_cast(:loop, state) do
    case WorkerManager.pop(DownloaderManager) do
      :empty ->
        if state.active do
          Status.put(state.id, "Idle")
        end

        {:noreply, %{state | active: false}}

      {url, cb, guard} = job ->
        if guard == nil or guard.() do
          Status.put(state.id, "Downloading #{url}")

          HTTPoison.get(url, [], recv_timeout: 30000)
          |> case do
            {:ok, %HTTPoison.Response{body: body}} ->
              cb.({:ok, body})

            err ->
              cb.({:err, url, err})
          end
        else
          Status.put(state.id, "Failed guard for #{url}")
        end

        WorkerManager.finish(DownloaderManager, job)

        GenServer.cast(self(), :loop)

        {:noreply, %{state | active: true}}
    end
  end

  def get() do
    WorkerManager.get(DownloaderManager)
  end

  def add(url, cb, guard \\ nil) do
    WorkerManager.add(DownloaderManager, {url, cb, guard})
  end

  def _save({:ok, data}, suffix, cb) do
    prefix = UUID.uuid3(UUID.uuid1(), suffix)

    path = Path.join(@tmp_dir, "#{prefix}_#{suffix}")

    {:ok, file} = File.open(path, [:write])
    IO.binwrite(file, data)
    File.close(file)

    cb.(path)
  end

  def _save({:err, url, _err}, suffix, cb) do
    save(url, suffix, cb)
  end

  def save(url, suffix, cb) do
    WorkerManager.add(DownloaderManager, {url, &_save(&1, suffix, cb), nil})
  end

  def save_all(files) do
    files =
      Enum.map(files, fn {url, suffix, cb} ->
        {url, &_save(&1, suffix, cb), nil}
      end)

    WorkerManager.add_all(DownloaderManager, files)
  end
end
