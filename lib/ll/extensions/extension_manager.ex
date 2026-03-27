defmodule LL.ExtensionManager do
  use Agent

  require Logger
  require LL.Downloader
  alias LL.{Downloader, Repo, Extension, Source, Series, Chapter, Message}
  alias LLWeb.Endpoint

  @extensions_path "extensions"
  @manager_api "http://localhost:8000/"

  defstruct remote: [],
            local: []

  def start_link(_opts) do
    Agent.start_link(fn -> %__MODULE__{} end, name: __MODULE__)
  end

  def get() do
    Agent.get(__MODULE__, & &1)
  end

  def extension_repo(), do: "https://raw.githubusercontent.com/keiyoushi/extensions/repo/"

  def update_remote() do
    Downloader.get extension_repo() <> "index.json" do
      {:ok, body, _headers} ->
        case Jason.decode(body, keys: :atoms) do
          {:ok, arr} ->
            Agent.update(__MODULE__, &Map.put(&1, :remote, arr))

            Endpoint.broadcast("extensions", "remote", arr)

          err ->
            Logger.error(inspect(err))
            Message.create("Error", inspect(err))
        end

      err ->
        Logger.error(inspect(err))
        Message.create("Error", inspect(err))
    end
  end

  def update_local() do
    arr = Repo.all(Extension) |> Repo.preload(:sources)

    Agent.update(__MODULE__, &Map.put(&1, :local, arr))

    Endpoint.broadcast("extensions", "local", arr)
  end

  def install(pkg) do
    get().remote
    |> Enum.filter(&(&1.pkg == pkg))
    |> case do
      [%{apk: apk, name: ext_name, version: ext_version}] ->
        Downloader.get extension_repo() <> "apk/" <> apk do
          {:ok, body, _headers} ->
            path = Path.expand(@extensions_path <> "/" <> apk)
            {:ok, file} = File.open(path, [:write])
            IO.binwrite(file, body)
            File.close(file)

            Downloader.post path, @manager_api <> "process_extension", :local do
              {:ok, sources} ->
                Repo.transact(fn ->
                  extension =
                    Ecto.Changeset.change(%Extension{}, %{
                      name: ext_name,
                      pkg: pkg,
                      version: ext_version,
                      path: path
                    })
                    |> Repo.insert!()

                  sources =
                    Enum.map(sources, fn source ->
                      Ecto.Changeset.change(%Source{}, %{
                        extension_id: extension.id,
                        source_id: source.id,
                        name: source.name,
                        lang: source.lang,
                        base_url: source.base_url
                      })
                      |> Repo.insert()
                      |> elem(1)
                    end)

                  {:ok, sources}
                end)
                |> case do
                  {:ok, _} ->
                    LL.SourceManager.update_sources()

                    update_local()

                  err ->
                    Logger.error(inspect(err))
                    Message.create("Error", inspect(err))
                end

              err ->
                Logger.error(inspect(err))
                Message.create("Error", inspect(err))
            end

          err ->
            Logger.error(inspect(err))
            Message.create("Error", inspect(err))
        end

      _ ->
        Logger.error("#{pkg} not found in remote extensions")
    end
  end

  def download_thumbnail(series) do
    if series.thumbnail_url != nil do
      Downloader.get series.thumbnail_url do
        {:ok, body, _headers} ->
          ext = series.thumbnail_url |> URI.parse() |> Map.get(:path) |> Path.extname()
          path = Path.expand("thumbnails/#{Ecto.UUID.generate()}#{ext}")
          {:ok, file} = File.open(path, [:write])
          IO.binwrite(file, body)
          File.close(file)

          {:ok, series} =
            Ecto.Changeset.change(series, %{thumbnail_path: path})
            |> Repo.update()

          Endpoint.broadcast("series:#{series.id}", "update", series)
          Endpoint.broadcast("series_thumb:#{series.id}", "update", series)

        err ->
          Logger.error(inspect(err))
          Message.create("Error", inspect(err))
      end
    end
  end

  def search(source, query, filters, page, cb) do
    %{
      extension: source.extension.path,
      source: source.source_id,
      query: query,
      page: page,
      filters: filters
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "search", :local do
      {:ok, %{results: results, has_next: has_next}} ->
        results =
          Enum.map(results, fn m ->
            series =
              case Repo.get_by(Series, url: m.url) do
                nil ->
                  {:ok, series} =
                    Ecto.Changeset.change(%Series{}, %{
                      source_id: source.id,
                      url: m.url,
                      title: m.title,
                      artist: m.artist,
                      author: m.author,
                      description: m.description,
                      genre: m.genre,
                      status: m.status,
                      thumbnail_url: m.thumbnail_url
                    })
                    |> Repo.insert()

                  series

                series ->
                  series
              end

            if series.thumbnail_url != nil and
                 not String.contains?(series.thumbnail_url, "keiyoushi-chapter-cover") do
              download_thumbnail(series)
            end

            series
          end)

        cb.(results, has_next)

      err ->
        Logger.error(inspect(err))
        Message.create("Error", inspect(err))
    end
  end

  def series_details(series) do
    source = Repo.get(Source, series.source_id) |> Repo.preload(:extension)

    %{
      extension: source.extension.path,
      source: source.source_id,
      url: series.url
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "series_details", :local do
      {:ok, j} ->
        {:ok, series} =
          Repo.transact(fn ->
            Repo.reload(series)
            |> Ecto.Changeset.change(%{
              title: j.title,
              artist: j.artist,
              author: j.author,
              description: j.description,
              genre: j.genre,
              status: j.status,
              thumbnail_url: j.thumbnail_url,
              details_updated: DateTime.utc_now() |> DateTime.truncate(:second)
            })
            |> Repo.update()
          end)

        Endpoint.broadcast("series:#{series.id}", "update", series)

      # TODO: if thumbnail url is different, redownload

      err ->
        Logger.error(inspect(err))
        Message.create("Error", inspect(err))
    end
  end

  def get_number(j) when j.number != -1, do: j.number

  def get_number(j) do
    cond do
      match = Regex.run(~r/Vol\..+? Ch\.([0-9\.]+)/, j.title) ->
        [_, g] = match
        {n, _} = Float.parse(g)
        n

      match = Regex.run(~r/Volume .+? Chapter ([0-9\.]+)/, j.title) ->
        [_, g] = match
        {n, _} = Float.parse(g)
        n

      true ->
        j.number
    end
  end

  def series_chapters(series) do
    source = Repo.get(Source, series.source_id) |> Repo.preload(:extension)

    %{
      extension: source.extension.path,
      source: source.source_id,
      url: series.url
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "series_chapters", :local do
      {:ok, j} ->
        Repo.transact(fn ->
          chapters =
            Enum.map(j.results, fn chapter_j ->
              {new, chapter} =
                case Repo.get_by(Chapter,
                       series_id: series.id,
                       source_id: source.id,
                       url: chapter_j.url
                     ) do
                  nil ->
                    {true,
                     %Chapter{
                       series_id: series.id,
                       source_id: source.id,
                       url: chapter_j.url
                     }}

                  chapter ->
                    {false, chapter}
                end

              {new, chapter,
               %{
                 number: get_number(chapter_j),
                 scanlator: chapter_j.scanlator,
                 title: chapter_j.title,
                 date:
                   DateTime.from_unix!(chapter_j.date, :millisecond)
                   |> DateTime.truncate(:second)
               }}
            end)

          chapters =
            chapters
            |> Enum.with_index()
            |> Enum.map(fn {{new, chapter, opts}, i} ->
              number =
                if opts.number != -1.0 do
                  opts.number
                else
                  {backwards, backwards_count} =
                    Enum.take(chapters, i)
                    |> Enum.map(&elem(&1, 2).number)
                    |> Enum.reverse()
                    |> Enum.reduce_while({nil, 1}, fn n, {_, acc} ->
                      if n != -1.0 do
                        {:halt, {n, acc}}
                      else
                        {:cont, acc + 1}
                      end
                    end)

                  {forwards, forwards_count} =
                    Enum.drop(chapters, i + 1)
                    |> Enum.map(&elem(&1, 2).number)
                    |> Enum.reduce_while({nil, 1}, fn n, {_, acc} ->
                      if n != -1.0 do
                        {:halt, {n, acc}}
                      else
                        {:cont, acc + 1}
                      end
                    end)

                  cond do
                    backwards != nil and forwards != nil ->
                      total = backwards_count + forwards_count

                      backwards / total * backwards_count + forwards / total * forwards_count

                    forwards != nil ->
                      forwards + 0.5

                    backwards != nil ->
                      0.0

                    true ->
                      -1.0
                  end
                end

              chapter =
                Ecto.Changeset.change(chapter, Map.put(opts, :number, number))
                |> Repo.insert_or_update!()

              {new, chapter}
            end)

          series =
            Repo.reload(series)
            |> Ecto.Changeset.change(%{
              chapters_updated: DateTime.utc_now() |> DateTime.truncate(:second)
            })
            |> Repo.update!()

          if series.in_library do
            Enum.filter(chapters, &elem(&1, 0))
            |> Enum.each(fn {_, c} ->
              Message.create("{:library,#{series.id}}", "New chapter {:chapter,#{c.id}}")
              download_chapter(c, source)
            end)
          end

          chapters = Enum.map(chapters, &elem(&1, 1))

          {:ok, {chapters, series}}
        end)
        |> case do
          {:ok, {chapters, series}} ->
            Endpoint.broadcast("chapters:#{series.id}", "update", chapters)
            Endpoint.broadcast("series:#{series.id}", "update", series)

          err ->
            Logger.error(inspect(err))
            Message.create("Error", inspect(err))
        end

      err ->
        Logger.error(inspect(err))
        Message.create("Error", inspect(err))
    end
  end

  def download_chapter(chapter, source) do
    %{
      extension: source.extension.path,
      source: source.source_id,
      url: chapter.url
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "chapter_pages", :local do
      {:ok, %{results: results}} ->
        Repo.transact(fn ->
          Repo.get(Chapter, chapter.id)
          |> Ecto.Changeset.change(%{files: List.duplicate("", length(results))})
          |> Repo.update()
        end)
        |> case do
          {:ok, chapter} ->
            results
            |> Enum.with_index()
            |> Enum.each(&download_page(chapter, source, elem(&1, 0), elem(&1, 1)))

          err ->
            Logger.error(inspect(err))
            Message.create("Error", inspect(err))
        end

      err ->
        Logger.error(inspect(err))
        Message.create("Error", inspect(err))
    end
  end

  def save_page(body, ext, chapter, index) do
    to_pad = chapter.files |> length |> to_string |> String.length()
    number = index |> to_string |> String.pad_leading(to_pad, "0")
    filename = "#{number}.#{ext}"

    Repo.transact(fn ->
      chapter_path = LL.Paths.get(chapter)
      :ok = File.mkdir_p(chapter_path)

      path = Path.join(chapter_path, filename)
      {:ok, file} = File.open(path, [:write])
      IO.binwrite(file, body)
      File.close(file)

      Logger.info("saved to #{path}")

      chapter = Repo.reload(chapter)

      files = List.replace_at(chapter.files, index, path)

      Ecto.Changeset.change(chapter, %{
        files: files
      })
      |> Repo.update()
    end)
    |> case do
      {:ok, chapter} ->
        Endpoint.broadcast("chapter:#{chapter.id}", "update", chapter)

      err ->
        Logger.error(inspect(err))
        Message.create("Error", inspect(err))
    end
  end

  def get_ext(headers) do
    headers
    |> Enum.filter(&(elem(&1, 0) == "Content-Type"))
    |> Enum.at(0)
    |> elem(1)
    |> MIME.extensions()
    |> Enum.at(0)
  end

  def download_page(chapter, source, page, index) do
    %{image_url: url} = page

    if URI.parse(url).scheme == nil do
      Map.merge(page, %{
        extension: source.extension.path,
        source: source.source_id
      })
      |> Jason.encode!()
      |> Downloader.post @manager_api <> "image" do
        {:ok, body, headers} ->
          save_page(body, get_ext(headers), chapter, index)

        err ->
          Logger.error(inspect(err))
          Message.create("Error", inspect(err))
      end
    else
      Downloader.get url do
        {:ok, body, headers} ->
          save_page(body, get_ext(headers), chapter, index)

        err ->
          Logger.error(inspect(err))
          Message.create("Error", inspect(err))
      end
    end
  end

  def filters(source, cb) do
    %{
      extension: source.extension.path,
      source: source.source_id
    }
    |> Jason.encode!()
    |> Downloader.post @manager_api <> "filters" do
      {:ok, resp} ->
        cb.(resp)
        LL.Source.update_filters(source, resp)

      err ->
        Logger.error(inspect(err))
        Message.create("Error", inspect(err))
    end
  end
end
