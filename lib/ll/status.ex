defmodule LL.Status do
  use Agent

  def start_link(_opts) do
    Agent.start_link(fn -> %{} end, name: __MODULE__)
  end

  def all() do
    Agent.get(__MODULE__, & &1)
  end

  def get(key) do
    Agent.get(__MODULE__, &Map.get(&1, key))
  end

  def put(key, value) do
    current_time = DateTime.utc_now() |> DateTime.to_string()
    Agent.update(__MODULE__, &Map.put(&1, key, "[#{current_time}] #{value}"))
    LLWeb.StatusLive.update()
  end

  def delete(key) do
    Agent.update(__MODULE__, &Map.delete(&1, key))
    LLWeb.StatusLive.update()
  end
end
