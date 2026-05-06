defmodule LL.SourceManager do
  use Agent

  alias LL.{Repo, Source}

  defstruct sources: []

  def start_link(_opts) do
    Agent.start_link(
      fn ->
        sources = Repo.all(Source) |> Repo.preload(:extension)

        %__MODULE__{sources: sources}
      end,
      name: __MODULE__
    )
  end

  def get() do
    Agent.get(__MODULE__, & &1)
  end

  def update_sources() do
    sources = Repo.all(Source) |> Repo.preload(:extension)

    Agent.update(__MODULE__, &%{&1 | sources: sources})

    LLWeb.Endpoint.broadcast("sources", "update", sources)
  end
end
