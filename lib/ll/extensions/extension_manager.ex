defmodule LL.ExtensionManager do
  use Agent

  require LL.Downloader
  alias LL.{Downloader, Repo, Extension, Source, Series, Chapter, Tag}

  @extension_repo "https://raw.githubusercontent.com/keiyoushi/extensions/repo/"
  @extensions_path "extensions"
  @manager_api "http://localhost:8000"

  defstruct remote: [],
            local: []

  def start_link(_opts) do
    Agent.start_link(fn -> %__MODULE__{} end, name: __MODULE__)
  end

  def get() do
    Agent.get(__MODULE__, & &1)
  end

  def update_remote() do
    Downloader.get @extension_repo <> "index.json" do
      {:ok, body, _headers} ->
        case Jason.decode(body) do
          {:ok, arr} ->
            Agent.update(__MODULE__, &%__MODULE__{&1 | remote: arr})
            LLWeb.ExtensionsLive.update_remote(arr)

          err ->
            IO.inspect(err)
        end

      err ->
        IO.inspect(err)
    end
  end

  def update_local() do
    arr = Repo.all(Extension)
    Agent.update(__MODULE__, &%__MODULE__{&1 | local: arr})
    LLWeb.ExtensionsLive.update_local(arr)
  end

  def install(pkg) do
    get().remote
    |> Enum.filter(&(&1["pkg"] == pkg))
    |> case do
      [%{"apk" => apk, "name" => ext_name, "version" => ext_version}] ->
        Downloader.get @extension_repo <> "apk/" <> apk do
          {:ok, body, _headers} ->
            path = Path.expand(@extensions_path <> "/" <> apk)
            {:ok, file} = File.open(path, [:write])
            IO.binwrite(file, body)
            File.close(file)

            Downloader.post path, @manager_api <> "/process_extension", :local do
              {:ok, sources} ->
                Repo.transact(fn ->
                  {:ok, extension} =
                    Ecto.Changeset.change(%Extension{}, %{
                      name: ext_name,
                      pkg: pkg,
                      version: ext_version,
                      path: path
                    })
                    |> Repo.insert()

                  sources =
                    Enum.map(sources, fn source ->
                      Ecto.Changeset.change(%Source{}, %{
                        extension_id: extension.id,
                        source_id: source["id"],
                        name: source["name"],
                        lang: source["lang"],
                        base_url: source["base_url"]
                      })
                      |> Repo.insert()
                      |> elem(1)
                    end)

                  {:ok, sources}
                end)

                LL.SourceManager.update_sources()

                update_local()

              err ->
                IO.inspect(err)
            end

          err ->
            IO.inspect(err)
        end

      _ ->
        IO.inspect("nothing")
    end
  end

  def download_thumbnail(series) do
    if series.thumbnail_url != nil do
      Downloader.get series.thumbnail_url do
        {:ok, body, _headers} ->
          ext = Path.extname(series.thumbnail_url)
          path = Path.expand("thumbnails/#{Ecto.UUID.generate()}#{ext}")
          {:ok, file} = File.open(path, [:write])
          IO.binwrite(file, body)
          File.close(file)

          {:ok, series} =
            Ecto.Changeset.change(series, %{thumbnail_path: path})
            |> Repo.update()

          LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

        err ->
          IO.inspect(err)
      end
    end
  end

  def search(source, %{id: search_id, query: query, page: page}, cb) do
    %{
      extension: source.extension.path,
      source: source.source_id,
      query: query,
      page: page
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "/search", :local do
      {:ok, %{"results" => results}} ->
        results =
          Enum.map(results, fn m ->
            case Repo.get_by(Series, url: m["url"]) do
              nil ->
                {:ok, series} =
                  Ecto.Changeset.change(%Series{}, %{
                    source_id: source.id,
                    url: m["url"],
                    title: m["title"],
                    artist: m["artist"],
                    author: m["author"],
                    description: m["description"],
                    genre: m["genre"],
                    status: m["status"],
                    thumbnail_url: m["thumbnail_url"]
                  })
                  |> Repo.insert()

                download_thumbnail(series)

                series

              series ->
                series
            end
          end)

        cb.(results)

      err ->
        IO.inspect(err)
    end
  end

  def series_details(series) do
    %{
      "extension" => series.source.extension.path,
      "source" => series.source.source_id,
      "url" => series.url
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "/get_details", :local do
      {:ok, j} ->
        {:ok, series} =
          Ecto.Changeset.change(series, %{
            title: j["title"],
            artist: j["artist"],
            author: j["author"],
            description: j["description"],
            genre: j["genre"],
            status: j["status"],
            thumbnail_url: j["thumbnail_url"]
          })
          |> Repo.update()

        LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

      # TODO: if thumbnail url is different, redownload

      err ->
        IO.inspect(err)
    end
  end

  def series_chapters(series) do
    %{
      "extension" => series.source.extension.path,
      "source" => series.source.source_id,
      "url" => series.url
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "/get_chapters", :local do
      {:ok, j} ->
        {:ok, chapters} =
          Repo.transact(fn ->
            chapters =
              Enum.map(j["results"], fn chapter_j ->
                case Repo.get_by(Chapter,
                       series_id: series.id,
                       source_id: series.source_id,
                       url: chapter_j["url"]
                     ) do
                  nil ->
                    %Chapter{
                      series_id: series.id,
                      source_id: series.source_id,
                      url: chapter_j["url"]
                    }

                  chapter ->
                    chapter
                end
                |> Ecto.Changeset.change(%{
                  number: chapter_j["number"],
                  scanlator: chapter_j["scanlator"],
                  title: chapter_j["title"],
                  date:
                    DateTime.from_unix!(chapter_j["date"], :millisecond)
                    |> DateTime.truncate(:second)
                })
                |> Repo.insert_or_update!()
              end)

            {:ok, chapters}
          end)

        LLWeb.Endpoint.broadcast("chapters:#{series.id}", "update", chapters)

      err ->
        IO.inspect(err)
    end
  end
end
