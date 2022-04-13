defmodule LL.Timer do
  use GenServer

  defstruct id: nil, fun: nil, interval: nil

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: opts[:name])
  end

  def init(opts) do
    send(self(), :loop)

    {:ok,
     %__MODULE__{
       id: {__MODULE__, opts[:id]},
       fun: opts[:fun],
       interval: opts[:interval]
     }}
  end

  def handle_info(:loop, state) do
    state.fun.()
    LL.Status.put(state.id, "#{inspect(state.fun)} #{state.interval}")
    Process.send_after(self(), :loop, state.interval)
    {:noreply, state}
  end
end
