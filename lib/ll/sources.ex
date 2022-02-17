defmodule LL.Sources do
  use GenServer

  alias LL.{Repo, Source, Status, Category}

  @source_modules %{
    "dynasty" => LL.Sources.Dynasty
  }

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts)
  end

  def init(_opts) do
    {:ok, %{}}
  end

  def add_source(source, type, data_url, category) do
    category = Repo.get(Category, category)
    %Source{}
    |> Ecto.Changeset.change(%{source: source, type: type, data_url: data_url})
    |> Ecto.Changeset.put_assoc(:category, category)
    |> Repo.insert()
  end

  def sync() do
    Status.put("Sources", "Synced")

    Repo.all(Source)
    |> Repo.preload(:category)
    |> Enum.each(fn source ->
      Map.get(@source_modules, source.source).sync(source)
    end)
  end

  def source_module(id) when is_atom(id), do: source_module(Atom.to_string(id))

  def source_module(id), do: Map.get(@source_modules, id)

  def create_category() do
    %Category{
      id: "love_live",
      name: "Love Live!"
    }
    |> Repo.insert()

    %Category{
      id: "bang_dream",
      name: "BanG Dream!"
    }
    |> Repo.insert()
  end

  def add_category() do
    #ll = Repo.get(Category, "love_live")
    bandori = Repo.get(Category, "bang_dream")

    Repo.all(Source)
    |> Repo.preload(:category)
    |> Enum.each(fn source ->
      if source.id >= 6 do
        Ecto.Changeset.change(source, %{})
        |> Ecto.Changeset.put_assoc(:category, bandori)
        |> Repo.update()
      end
    end)
  end

end
