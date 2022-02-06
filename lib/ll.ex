defmodule LL do
  @moduledoc """
  LL keeps the contexts that define your domain
  and business logic.

  Contexts are also responsible for managing your data, regardless
  if it comes from the database, an external API or others.
  """

  alias LL.{Repo, Downloader, Encoder, Chapter, Series, Tag, Sources}

  def reset() do
    Repo.delete_all(Tag)
    Repo.delete_all(Chapter)
    Repo.delete_all(Series)
  end

  def add_sources() do
    Sources.add_source("dynasty", 0, "love_live")
    Sources.add_source("dynasty", 0, "love_live_sunshine")
    Sources.add_source("dynasty", 0, "love_live_nijigasaki_academy_school_idol_club")
    Sources.add_source("dynasty", 0, "love_live_superstar")

    Sources.add_source("dynasty", 1, "kimino_sakurako")
  end

  def sync() do
    Sources.sync()
  end

  def sync_pages() do
    Repo.all(Chapter)
    |> Enum.map(fn c ->
      Sources.Dynasty.download_pages(c)
    end)
    |> Enum.reduce([], &(&1 ++ &2))
    |> Downloader.save_all()
  end

  def encode_pages() do
    Repo.all(Chapter)
    |> Repo.preload(:series)
    |> Enum.each(fn c ->
      Enum.with_index(c.files)
      |> Enum.filter(&String.starts_with?(elem(&1, 0), "tmp/"))
      |> Enum.each(fn {path, i} ->
        filename =
          path
          |> String.slice(41..-1)
          |> String.slice((String.length(c.id) + 1)..-1)

        new_filename = Path.rootname(filename) <> ".jxl"

        new_path =
          if c.series do
            Path.join("files/dynasty", c.series.id)
          else
            "files/dynasty"
          end
          |> Path.join(c.id)
          |> Path.join(new_filename)

        Encoder.add(c.id, i, path, new_path)
      end)
    end)
  end

  def sync_assoc() do
    Repo.all(Chapter)
    |> Repo.preload([:tags, :series])
    |> Enum.filter(&(&1.series == nil))
    |> Enum.each(fn c ->
      Enum.filter(c.tags, &(&1.type == 1))
      |> Enum.each(fn tag ->
        case Repo.get(Series, tag.id) do
          nil ->
            nil

          series ->
            Chapter.change(c, %{})
            |> Chapter.put_series(series)
            |> Repo.update()
        end
      end)
    end)
  end

  def all() do
    Repo.all(Chapter)
    |> Repo.preload(:series)
    |> Enum.map(&if &1.series, do: &1.series, else: &1)
    |> Enum.map(& &1.id)
    |> Enum.uniq()
  end

  def series_tags() do
    Repo.all(Series)
    |> Repo.preload([:tags, {:chapters, :tags}])
    |> Enum.each(fn s ->
      s_tags = s.tags |> Enum.map(& &1.id)

      tags =
        Enum.map(s.chapters, & &1.tags)
        |> List.flatten()
        |> Enum.uniq()
        |> Enum.filter(&(&1.id not in s_tags))

      tags =
        (s.tags ++ tags)
        |> Enum.filter(&(&1.type != 3 and &1.type != 1))

      Ecto.Changeset.change(s, %{})
      |> Ecto.Changeset.put_assoc(:tags, tags)
      |> Repo.update()
    end)
  end

  def check_missing_pages() do
    files =
      Repo.all(Chapter)
      |> Repo.preload(:series)
      |> Enum.map(fn c -> c.files |> Enum.map(&{{c.id, c.series}, &1}) end)
      |> List.flatten()

    files
    |> Enum.filter(&String.starts_with?(elem(&1, 1), "/"))

    # |> Enum.filter(&(!File.exists?(&1)))
  end
end
