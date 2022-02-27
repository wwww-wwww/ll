defmodule LL do
  @moduledoc """
  LL keeps the contexts that define your domain
  and business logic.

  Contexts are also responsible for managing your data, regardless
  if it comes from the database, an external API or others.
  """

  alias LL.{Repo, Downloader, Encoder, Chapter, Series, Tag, Sources}

  def reset_reset_reset_reset_reset() do
    Repo.delete_all(Tag)
    Repo.delete_all(Chapter)
    Repo.delete_all(Series)
  end

  def add_sources() do
    Sources.add_source("dynasty", 0, "love_live", "love_live")
    Sources.add_source("dynasty", 0, "love_live_sunshine", "love_live")
    Sources.add_source("dynasty", 0, "love_live_nijigasaki_academy_school_idol_club", "love_live")
    Sources.add_source("dynasty", 0, "love_live_superstar", "love_live")

    Sources.add_source("dynasty", 1, "kimino_sakurako", "love_live")

    Sources.add_source("dynasty", 0, "bang_dream", "bang_dream")
    Sources.add_source("dynasty", 3, "bang_dream_girls_band_party_roselia_stage", "bang_dream")
    Sources.add_source("dynasty", 3, "bang_dream_4_koma_bandori", "bang_dream")
    Sources.add_source("dynasty", 3, "bang_dream_raise_the_story_of_my_music", "bang_dream")
    Sources.add_source("dynasty", 3, "bangdream_star_beat", "bang_dream")
  end

  def sync() do
    Sources.sync()
  end

  def sync_pages() do
    Repo.all(Chapter)
    |> Enum.map(fn c ->
      Sources.Dynasty.download_pages(c)
    end)
    |> List.flatten()
    |> Downloader.save_all()
  end

  def encode_pages(exec) do
    pages =
      Repo.all(Chapter)
      |> Repo.preload(:series)
      |> Enum.map(fn c ->
        Enum.with_index(c.files)
        |> Enum.filter(&String.starts_with?(elem(&1, 0), "tmp/"))
        |> Enum.map(fn {path, i} ->
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

          {c.id, i, path, new_path}
        end)
      end)
      |> List.flatten()

    if exec do
      pages |> Encoder.add_all()
    else
      pages
    end
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
        |> Enum.filter(&(&1.type != 1))

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
    # |> Enum.filter(&not String.starts_with?(elem(&1, 1), "tmp"))
    # |> Enum.filter(&String.starts_with?(elem(&1, 1), "/tank"))
    |> Enum.filter(&(not File.exists?("/tank/main/llm/" <> elem(&1, 1))))

    # |> Enum.filter(&(!File.exists?(&1)))
  end

  def set_category() do
    ll =
      Repo.insert_all(Tag, [%{id: "category_love_live", name: "Love Live!", type: 4}],
        on_conflict: :nothing
      )

    ll = Repo.get(Tag, "category_love_live")

    bandori =
      Repo.insert_all(Tag, [%{id: "category_bang_dream", name: "BanG Dream!", type: 4}],
        on_conflict: :nothing
      )

    bandori = Repo.get(Tag, "category_bang_dream")

    Repo.all(Series)
    |> Repo.preload([:tags, :chapters])
    |> Enum.map(fn c ->
      c
      |> Ecto.Changeset.change(%{})
      |> Chapter.put_tags(c.tags ++ [ll])
      |> Repo.update()

      # |> Repo.insert()
    end)
  end
end
