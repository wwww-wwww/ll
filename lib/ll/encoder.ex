defmodule LL.Encoder do
  use GenServer

  alias LL.{Chapter, WorkerManager, EncoderManager, Status}

  @accepted_exts [".png", ".jpg", ".jpeg"]

  defstruct id: nil, active: false

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: String.to_atom("#{__MODULE__}_#{opts[:id]}"))
  end

  def init(opts) do
    send(self(), :startup)
    {:ok, %__MODULE__{id: {__MODULE__, opts[:id]}}}
  end

  def handle_info(:startup, state) do
    GenServer.call(EncoderManager, {:register, self()})
    Status.put(state.id, "Idle")

    GenServer.cast(self(), :loop)
    {:noreply, state}
  end

  def handle_cast(:loop, state) do
    case WorkerManager.pop(EncoderManager) do
      :empty ->
        if state.active do
          Status.put(state.id, "Idle")
        end

        {:noreply, %{state | active: false}}

      {id, n, path, new_path} = job ->
        if (Path.extname(path) |> String.downcase()) in @accepted_exts do
          Status.put(state.id, "Encoding #{id} #{n} #{path} -> #{new_path}")

          new_path_disk = Path.join(LL.files_root(), new_path)

          new_path_disk
          |> Path.dirname()
          |> File.mkdir_p()

          if not File.exists?(new_path_disk) do
            case System.cmd("python3", ["convert.py", path, new_path_disk, "--check-color"],
                   stderr_to_stdout: true
                 ) do
              {_, 0} ->
                nil

              err ->
                IO.inspect(err)
                add(id, n, path, new_path)
            end
          end

          if File.exists?(new_path_disk) do
            Chapter.update_file(id, n, new_path, true)
            File.rm(path)
          end
        end

        WorkerManager.finish(EncoderManager, job)

        GenServer.cast(self(), :loop)

        {:noreply, %{state | active: true}}
    end
  end

  def get() do
    WorkerManager.get(EncoderManager)
  end

  def add(id, n, path, new_path) do
    WorkerManager.add(EncoderManager, {id, n, path, new_path})
  end

  def add_all(jobs) when length(jobs) > 0 do
    WorkerManager.add_all(EncoderManager, jobs)
  end

  def add_all(_), do: nil
end
