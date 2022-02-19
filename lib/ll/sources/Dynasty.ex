defmodule LL.Sources.Dynasty do
  import Ecto.Query, only: [from: 2]

  alias LL.{Chapter, Series, Tag, Downloader, Encoder, Status, Repo, CriticalWriter}

  @root "https://dynasty-scans.com"

  @file_path "files/dynasty"
  @file_path_covers "covers/dynasty"

  @tag_type %{
    "General" => 0,
    "Pairing" => 0,
    "Doujin" => 0,
    "Series" => 1,
    "Anthology" => 1,
    "Author" => 2,
    "Scanlator" => 3
  }

  @tag_types Map.keys(@tag_type)

  @grouping_paths %{
    "Series" => "series",
    "Anthology" => "anthologies"
  }

  @groupings_ids %{
    "series" => 0,
    "anthologies" => 1
  }

  @grouping_from_ids Map.new(@groupings_ids, fn {key, val} -> {val, key} end)

  @groupings Map.keys(@grouping_paths)

  @accepted_exts [".png", ".jpg", ".jpeg"]

  def sync(%{type: 0, data_url: data_url, category: category}) do
    Status.put("dynasty/doujins/#{data_url}/groupings", "Syncing")
    Status.put("dynasty/doujins/#{data_url}/chapters", "Syncing")

    Downloader.add(
      "#{@root}/doujins/#{data_url}.json?view=groupings",
      &on_groupings(:doujin, data_url, category, &1)
    )

    Downloader.add(
      "#{@root}/doujins/#{data_url}.json?view=chapters",
      &on_chapters(:doujin, data_url, category, &1)
    )
  end

  def sync(%{type: 1, data_url: data_url, category: category}) do
    Status.put("dynasty/authors/#{data_url}", "Syncing")
    Downloader.add("#{@root}/authors/#{data_url}.json", &on_authors(data_url, category, &1))
  end

  def sync(%{type: 2, data_url: data_url, category: category}) do
    Status.put("dynasty/chapters/#{data_url}", "Syncing")

    Downloader.add(
      "#{@root}/chapters/#{data_url}.json",
      &CriticalWriter.add(fn -> on_chapter(data_url, category, &1) end)
    )
  end

  def sync(%{type: 3, data_url: data_url, category: category}) do
    Status.put("dynasty/series/#{data_url}", "Syncing")

    Downloader.add(
      "#{@root}/series/#{data_url}.json",
      &CriticalWriter.add(fn ->
        Status.put("dynasty/series/#{data_url}", "Synced")
        on_series(data_url, "series", category, &1)
      end)
    )
  end

  def chapter_url(chapter_id), do: "#{@root}/chapters/#{chapter_id}"

  def series_url(series),
    do: "#{@root}/#{Map.get(@grouping_from_ids, series.type)}/#{series.source_id}"

  def get_chapter(permalink),
    do: Repo.one(from(s in Chapter, where: s.source_id == ^permalink and s.source == "dynasty"))

  def chapter_exists?(permalink),
    do: get_chapter(permalink) != nil

  def series_exists?(permalink) when not is_nil(permalink),
    do: Repo.one(from(s in Series, where: s.source_id == ^permalink)) != nil

  def category_tag(category) do
    Repo.insert_all(
      Tag,
      [
        %{
          id: "category_#{category.id}",
          name: category.name,
          type: 4
        }
      ],
      on_conflict: :nothing
    )

    Repo.get(Tag, "category_#{category.id}")
  end

  def get_series(tagging) do
    series_id =
      tagging["tags"]
      |> Enum.filter(&(&1["type"] in @groupings))
      |> Enum.map(& &1["permalink"])
      |> Enum.at(0)

    if series_id do
      Repo.one(from(s in Series, where: s.source_id == ^series_id))
    else
      nil
    end
  end

  def add_tags(tags) do
    tags =
      Enum.map(
        tags,
        &%{
          id: &1["permalink"],
          name: &1["name"],
          type: @tag_type[&1["type"]]
        }
      )

    Repo.insert_all(Tag, tags, on_conflict: :nothing)
  end

  def get_tags(tags) do
    Enum.map(tags, &Repo.get(Tag, &1["permalink"]))
  end

  def add_taggings_tags(taggings) do
    tags =
      taggings
      |> Enum.filter(&(&1["permalink"] != nil))
      |> Enum.map(fn %{"tags" => tags} ->
        tags
        |> Enum.filter(&(&1["type"] in @tag_types))
        |> Enum.map(
          &{
            &1["permalink"],
            &1["name"],
            @tag_type[&1["type"]]
          }
        )
      end)
      |> List.flatten()
      |> Enum.map(
        &%{
          id: elem(&1, 0),
          name: elem(&1, 1),
          type: elem(&1, 2)
        }
      )

    Repo.insert_all(Tag, tags, on_conflict: :nothing)
  end

  def on_groupings(:doujin, data_url, category, {:ok, data}) do
    case Jason.decode(data) do
      {:ok, %{"taggables" => taggables, "current_page" => page, "total_pages" => pages}} ->
        if Application.get_env(:ll, :get_all_pages) and page == 1 and page < pages do
          (page + 1)..pages
          |> Enum.each(fn p ->
            Downloader.add(
              "#{@root}/doujins/#{data_url}.json?view=groupings&page=#{p}",
              &on_groupings(:doujin, data_url, &1)
            )
          end)
        end

        taggables
        |> Enum.filter(&(!series_exists?(&1["permalink"])))
        |> Enum.each(fn %{"permalink" => permalink, "type" => type} ->
          grouping_path = @grouping_paths[type]

          Downloader.add(
            "#{@root}/#{grouping_path}/#{permalink}.json",
            &CriticalWriter.add(fn -> on_series(permalink, grouping_path, category, &1) end)
          )
        end)

        Status.put("dynasty/doujins/#{data_url}/groupings", "Synced")

      err ->
        Status.put("dynasty/doujins/#{data_url}/groupings", "Error: #{inspect(err)}")
    end
  end

  def on_groupings(:doujin, data_url, {:err, url, {:error, %{reason: :timeout}}}) do
    Downloader.add(
      url,
      &on_groupings(:doujin, data_url, &1)
    )
  end

  def on_chapters(:doujin, data_url, category, {:ok, data}) do
    case Jason.decode(data) do
      {:ok, %{"taggings" => taggings, "current_page" => page, "total_pages" => pages}} ->
        if Application.get_env(:ll, :get_all_pages) and page == 1 and page < pages do
          (page + 1)..pages
          |> Enum.each(fn p ->
            Downloader.add(
              "#{@root}/doujins/#{data_url}.json?view=chapters&page=#{p}",
              &on_chapters(:doujin, data_url, category, &1)
            )
          end)
        end

        add_taggings_tags(taggings)

        taggings
        |> Enum.filter(&(&1["permalink"] != nil))
        |> Enum.filter(&(!chapter_exists?(&1["permalink"])))
        |> Enum.each(fn %{"permalink" => permalink} = tagging ->
          case get_series(tagging) do
            nil ->
              Downloader.add(
                "#{@root}/chapters/#{permalink}.json",
                &CriticalWriter.add(fn -> on_chapter(permalink, category, &1) end)
              )

            series ->
              Downloader.add(
                "#{@root}/chapters/#{permalink}.json",
                &CriticalWriter.add(fn -> on_chapter(permalink, category, &1, series) end)
              )
          end
        end)

        Status.put("dynasty/doujins/#{data_url}/chapters", "Synced")

      err ->
        Status.put("dynasty/doujins/#{data_url}/chapters", "Error: #{inspect(err)}")
    end
  end

  def on_authors(data_url, category, {:ok, data}) do
    case Jason.decode(data) do
      {:ok, %{"taggables" => taggables}} ->
        taggables
        |> Enum.filter(&(!series_exists?(&1["permalink"])))
        |> Enum.each(fn %{"permalink" => permalink, "type" => type} ->
          grouping_path = @grouping_paths[type]

          Downloader.add(
            "#{@root}/#{grouping_path}/#{permalink}.json",
            &CriticalWriter.add(fn -> on_series(permalink, grouping_path, category, &1) end)
          )
        end)

        Status.put("dynasty/authors/#{data_url}", "Synced")

      err ->
        Status.put("dynasty/authors/#{data_url}", "Error: #{inspect(err)}")
    end
  end

  def on_authors(data_url, _category, err) do
    Status.put("dynasty/authors/#{data_url}", "Error: #{inspect(err)}")
  end

  # safe
  def on_chapter(data_url, category, {:ok, data}, series \\ nil) do
    if !chapter_exists?(data_url) do
      case Jason.decode(data) do
        {:ok, %{"added_on" => added_on, "pages" => pages, "tags" => tags} = data} ->
          add_tags(tags)

          tags = get_tags(tags) ++ [category_tag(category)]

          title = data["long_title"] || data["title"]

          pages = Enum.map(pages, & &1["url"])

          # TODO: id collision

          changeset =
            Chapter.change(%Chapter{}, %{
              id: data_url,
              title: title,
              source: "dynasty",
              source_id: data_url,
              date: NaiveDateTime.from_iso8601!(added_on) |> NaiveDateTime.to_date(),
              files: pages
            })

          {:ok, chapter} =
            if series do
              changeset
              |> Chapter.change(%{path: series.id})
              |> Chapter.put_series(series)
            else
              changeset
              |> Chapter.change(%{cover: Enum.at(pages, 0)})
            end
            |> Chapter.put_tags(tags)
            |> Repo.insert()

          # Request series to retrieve chapter/listing number
          tags
          |> Enum.filter(&(&1.type in @groupings))
          |> Enum.map(&{&1.type, &1.id})
          |> Enum.at(0)
          |> case do
            nil ->
              nil

            {type, permalink} ->
              grouping_path = @grouping_paths[type]

              Downloader.add(
                "#{@root}/#{grouping_path}/#{permalink}.json",
                &CriticalWriter.add(fn -> on_series(permalink, grouping_path, category, &1) end)
              )
          end

          download_cover(chapter)

          download_pages(chapter)
          |> Downloader.save_all()

        err ->
          Status.put("dynasty/chapters/#{data_url}", "Error: #{inspect(err)}")
      end
    end
  end

  # safe
  def on_series(data_url, grouping_type, category, {:ok, data}) do
    case Jason.decode(data) do
      {:ok,
       %{
         "name" => name,
         "cover" => cover,
         "description" => description,
         "taggings" => taggings,
         "tags" => tags
       }} ->
        taggings_tags =
          taggings
          |> Enum.filter(&(&1["permalink"] != nil))
          |> Enum.map(& &1["tags"])
          |> List.flatten()

        all_tags =
          (tags ++ taggings_tags)
          |> Enum.filter(&(&1["type"] in @tag_types))
          |> Enum.map(
            &%{
              id: &1["permalink"],
              name: &1["name"],
              type: @tag_type[&1["type"]]
            }
          )
          |> Enum.uniq()

        Repo.insert_all(Tag, all_tags, on_conflict: :nothing)

        cat_tag = category_tag(category)

        all_tags =
          all_tags
          |> Enum.filter(&(&1.type != 1))

        {:ok, series} =
          case Repo.get(Series, data_url) do
            nil ->
              # TODO: id collision
              %Series{
                id: data_url,
                cover: cover
              }

            s ->
              s |> Repo.preload(:tags)
          end
          |> Ecto.Changeset.change(%{
            title: name,
            description: description,
            source: "dynasty",
            source_id: data_url,
            type: @groupings_ids[grouping_type]
          })
          |> Ecto.Changeset.put_assoc(
            :tags,
            get_tags(Enum.map(all_tags, &%{"permalink" => &1.id})) ++ [cat_tag]
          )
          |> Repo.insert_or_update()

        download_cover(series)

        taggings
        |> Enum.filter(&(&1["permalink"] != nil))
        |> Enum.map(& &1["permalink"])
        |> Enum.filter(&(!chapter_exists?(&1)))
        |> Enum.each(fn permalink ->
          Downloader.add(
            "#{@root}/chapters/#{permalink}.json",
            &CriticalWriter.add(fn -> on_chapter(permalink, category, &1, series) end),
            fn -> !chapter_exists?(permalink) end
          )
        end)

        taggings
        |> Enum.filter(&(&1["permalink"] != nil))
        |> Enum.map(& &1["permalink"])
        |> Enum.with_index(1)
        |> Enum.each(fn {c_id, c_n} ->
          case get_chapter(c_id) do
            nil ->
              nil

            c ->
              Chapter.change(c, %{
                number: c_n
              })
              |> Repo.update()
          end
        end)

      err ->
        Status.put("dynasty/#{grouping_type}/#{data_url}", "Error: #{inspect(err)}")
    end
  end

  def download_pages(chapter) do
    chapter = Repo.preload(chapter, :series)

    chapter.files
    |> Enum.with_index()
    |> Enum.filter(&String.starts_with?(elem(&1, 0), "/"))
    |> Enum.map(fn {f, i} ->
      filename =
        URI.parse(f)
        |> Map.get(:path)
        |> Kernel.||("#{i}.jpg")
        |> URI.decode()
        |> Path.basename()

      if (Path.extname(filename) |> String.downcase()) in @accepted_exts do
        new_filename = Path.rootname(filename) <> ".jxl"

        new_path =
          if chapter.series do
            Path.join(@file_path, chapter.series.id)
          else
            @file_path
          end
          |> Path.join(chapter.id)
          |> Path.join(new_filename)

        {
          "#{@root}#{f}",
          "#{chapter.id}_#{filename}",
          fn new_file ->
            Chapter.update_file(chapter.id, i, new_file, false)
            Encoder.add(chapter.id, i, new_file, new_path)
          end
        }
      else
        nil
      end
    end)
    |> Enum.filter(&(!is_nil(&1)))
  end

  def download_cover(%Chapter{series_id: nil, cover: "/" <> cover} = chapter) do
    filename =
      URI.parse(cover)
      |> Map.get(:path)
      |> Kernel.||("cover")
      |> URI.decode()
      |> Path.basename()
      |> Path.rootname()
      |> Kernel.<>(".webp")

    Downloader.save("#{@root}/#{cover}", "#{chapter.id}_cover_#{filename}", fn path ->
      File.mkdir_p(@file_path_covers)
      new_path = Path.join(@file_path_covers, "chapter_#{chapter.id}_#{filename}")

      case System.cmd("python", ["covers.py", path, new_path]) do
        {_, 0} ->
          if File.exists?(new_path) do
            CriticalWriter.add(fn ->
              Repo.get(Chapter, chapter.id)
              |> Ecto.Changeset.change(%{cover: new_path})
              |> Repo.update()

              File.rm(path)
            end)
          end

        _ ->
          nil
      end
    end)
  end

  def download_cover(%Chapter{series_id: nil, cover: nil, files: files} = chapter) do
    case files |> Enum.at(0) do
      "/" <> _ = page_url ->
        CriticalWriter.add(fn ->
          Repo.get(Chapter, chapter.id)
          |> Ecto.Changeset.change(%{cover: page_url})
          |> Repo.update()
        end)

      _ ->
        Downloader.add(
          "#{@root}/chapters/#{chapter.source_id}.json",
          fn {:ok, data} ->
            case Jason.decode(data) do
              {:ok, data} ->
                first_page = data["pages"] |> Enum.at(0) |> Map.get("url")

                CriticalWriter.add(fn ->
                  Repo.get(Chapter, chapter.id)
                  |> Ecto.Changeset.change(%{cover: first_page})
                  |> Repo.update()

                  Repo.get(Chapter, chapter.id)
                  |> download_cover()
                end)

              _ ->
                nil
            end
          end
        )
    end
  end

  def download_cover(%Series{cover: "/" <> cover} = series) do
    filename =
      URI.parse(cover)
      |> Map.get(:path)
      |> Kernel.||("cover.jpg")
      |> URI.decode()
      |> Path.basename()

    Downloader.save("#{@root}/#{cover}", "#{series.id}_cover_#{filename}", fn path ->
      File.mkdir_p(@file_path_covers)
      new_path = Path.join(@file_path_covers, "series_#{series.id}_#{filename}")

      case File.rename(path, new_path) do
        :ok ->
          Ecto.Changeset.change(series, %{cover: new_path})
          |> Repo.update()

        _ ->
          nil
      end
    end)
  end

  def download_cover(_), do: nil
end
