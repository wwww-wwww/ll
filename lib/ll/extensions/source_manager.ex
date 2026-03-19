defmodule LL.SourceManager do
  use Agent

  alias LL.{Downloader, Repo, Extension, Source}

  defstruct sources: []

  def start_link(_opts) do
    Agent.start_link(
      fn ->
        sources = Repo.all(Source)
        %__MODULE__{sources: sources}
      end,
      name: __MODULE__
    )
  end

  def get() do
    Agent.get(__MODULE__, & &1)
  end

  def update_sources() do
    sources =
      Repo.all(Source)
      |> Enum.filter(&(&1.lang == "all" or &1.lang == "en"))

    Agent.update(__MODULE__, &%{&1 | sources: sources})
  end
end
