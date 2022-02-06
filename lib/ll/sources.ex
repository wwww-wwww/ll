defmodule LL.Sources do
  use GenServer

  alias LL.{Repo, Source, Status}

  @source_modules %{
    "dynasty" => LL.Sources.Dynasty
  }

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def init(_opts) do
    {:ok, %{}}
  end

  def add_source(source, type, data_url) do
    %Source{source: source, type: type, data_url: data_url}
    |> Repo.insert()
  end

  def sync() do
    Status.put("Sources", "Synced")

    Repo.all(Source)
    |> Enum.each(fn source ->
      Map.get(@source_modules, source.source).sync(source.type, source.data_url)
    end)
  end
end
