defmodule LL.WorkerManager do
  use GenServer

  alias LL.Status

  defstruct workers: [], queue: :queue.new(), working: [], name: nil

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: opts[:name])
  end

  def init(opts) do
    {:ok, %__MODULE__{name: to_string(opts[:name]) |> String.split(".") |> Enum.take(-1)}}
  end

  def handle_call(:get, _from, state) do
    {:reply, state, state}
  end

  def handle_call({:pop, track}, _from, state) do
    case :queue.out(state.queue) do
      {{:value, head}, queue} ->
        working =
          if track do
            state.working ++ [head]
          else
            state.working
          end

        Status.put(state.name, "#{:queue.len(queue)} items in queue, #{length(working)} working")

        LLWeb.StatusLive.update_queue(state.name, queue, working)

        {:reply, head, %{state | queue: queue, working: working}}

      {:empty, _queue} ->
        {:reply, :empty, state}
    end
  end

  def handle_call({:register, pid}, _from, state) do
    {:reply, :ok, %{state | workers: state.workers ++ [pid]}}
  end

  def handle_call({:finish, job}, _from, state) do
    working = state.working -- [job]

    Status.put(
      state.name,
      "#{:queue.len(state.queue)} items in queue, #{length(working)} working"
    )

    LLWeb.StatusLive.update_queue(state.name, state.queue, working)

    {:reply, :ok, %{state | working: working}}
  end

  def handle_cast({:add, element, track}, state) do
    {tail, head} = state.queue

    if not track or not (element in tail or element in head or element in state.working) do
      Enum.each(state.workers, &GenServer.cast(&1, :loop))
      queue = :queue.in(element, state.queue)

      Status.put(
        state.name,
        "#{:queue.len(queue)} items in queue, #{length(state.working)} working"
      )

      LLWeb.StatusLive.update_queue(state.name, queue, state.working)

      {:noreply, %{state | queue: queue}}
    else
      {:noreply, state}
    end
  end

  def handle_cast({:add_all, elements, track}, state) do
    if track do
      {tail, head} = state.queue

      elements
      |> Enum.filter(&(not (&1 in tail or &1 in head or &1 in state.working)))
    else
      elements
    end
    |> case do
      [] ->
        {:noreply, state}

      elements ->
        Enum.each(state.workers, &GenServer.cast(&1, :loop))
        queue = Enum.reduce(elements, state.queue, &:queue.in(&1, &2))

        Status.put(
          state.name,
          "#{:queue.len(queue)} items in queue, #{length(state.working)} working"
        )

        {:noreply, %{state | queue: queue}}
    end
  end

  def get(pid) do
    GenServer.call(pid, :get)
  end

  # safe not required since pop only moves
  def pop(pid, track \\ true) do
    GenServer.call(pid, {:pop, track})
  end

  def add(pid, element, track \\ true) do
    GenServer.cast(pid, {:add, element, track})
  end

  def add_all(pid, elements, track \\ true) do
    GenServer.cast(pid, {:add_all, elements, track})
  end

  def finish(pid, element) do
    GenServer.call(pid, {:finish, element})
  end
end
