defmodule LL.Downloader do
  use GenServer

  alias LL.{WorkerManager, Status}

  defstruct id: nil,
            active: false,
            queue: nil

  defmodule Task do
    defstruct url: "", type: :get, body: nil, cb: nil, guard: nil, time: nil
  end

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts,
      name: String.to_atom("#{__MODULE__}.#{opts[:queue]}.#{opts[:id]}")
    )
  end

  def init(opts) do
    send(self(), :startup)
    {:ok, %__MODULE__{id: {__MODULE__, opts[:id]}, queue: opts[:queue]}}
  end

  def handle_info(:startup, state) do
    GenServer.call(state.queue, {:register, self()})
    Status.put(state.id, "Idle")

    GenServer.cast(self(), :loop)
    {:noreply, state}
  end

  def handle_cast(:loop, state) do
    case WorkerManager.pop(state.queue) do
      :empty ->
        if state.active do
          Status.put(state.id, "Idle")
        end

        {:noreply, %{state | active: false}}

      %Task{} = task ->
        if task.guard == nil or task.guard.() do
          Status.put(state.id, "Downloading #{task.url}")

          body = if is_function(task.body), do: task.body.(), else: task.body

          HTTPoison.request(%HTTPoison.Request{
            method: task.type,
            url: task.url,
            body: body,
            options: [recv_timeout: 30000]
          })
          |> case do
            {:ok, %HTTPoison.Response{body: body, headers: headers}} ->
              task.cb.({:ok, body, headers})

            err ->
              task.cb.({:err, task.url, err})
          end
        else
          Status.put(state.id, "Failed guard for #{task.url}")
        end

        WorkerManager.finish(state.queue, task)

        GenServer.cast(self(), :loop)

        {:noreply, %{state | active: true}}
    end
  end

  def manager(queue) do
    WorkerManager.get(queue)
  end

  def add(queue, url, type, body, cb, guard \\ nil) do
    WorkerManager.add(queue, %Task{
      url: url,
      type: type,
      body: body,
      cb: cb,
      guard: guard,
      time: DateTime.utc_now()
    })
  end

  defmacro get(url, queue \\ :downloader, do: clauses) do
    quote do
      LL.Downloader.add(
        unquote(queue),
        unquote(url),
        :get,
        "",
        fn resp ->
          case resp do
            unquote(clauses)
          end
        end
      )
    end
  end

  defmacro post(body, url, queue \\ :downloader, do: clauses) do
    quote do
      LL.Downloader.add(
        unquote(queue),
        unquote(url),
        :post,
        unquote(body),
        fn resp ->
          case resp do
            {:ok, body, headers} ->
              if Enum.any?(headers, &(&1 == {"Content-Type", "application/json"})) do
                case Jason.decode(body, keys: :atoms) do
                  unquote(clauses)
                end
              else
                case resp do
                  unquote(clauses)
                end
              end

            err ->
              case err do
                unquote(clauses)
              end
          end
        end
      )
    end
  end
end
