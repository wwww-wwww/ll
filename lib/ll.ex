defmodule LL do
  @moduledoc """
  LL keeps the contexts that define your domain
  and business logic.

  Contexts are also responsible for managing your data, regardless
  if it comes from the database, an external API or others.
  """

  alias LL.{Repo, Downloader, Encoder, Chapter, Series, Sources}

  def files_root(), do: Application.get_env(:ll, :files_root)

  def add_sources() do
    Sources.add_source("dynasty", 0, "love_live", "love_live")
    Sources.add_source("dynasty", 0, "love_live_sunshine", "love_live")
    Sources.add_source("dynasty", 0, "love_live_nijigasaki_academy_school_idol_club", "love_live")
    Sources.add_source("dynasty", 0, "love_live_superstar", "love_live")

    Sources.add_source("dynasty", 1, "kimino_sakurako", "love_live")

    Sources.add_source("dynasty", 0, "bang_dream", "bang_dream")

    [
      "bang_dream_girls_band_party_roselia_stage",
      "bang_dream_4_koma_bandori",
      "bang_dream_raise_the_story_of_my_music",
      "bangdream_star_beat"
    ]
    |> Enum.each(&Sources.add_source("dynasty", 3, &1, "bang_dream"))

    Sources.add_source("dynasty", 0, "shoujo_kageki_revue_starlight", "revue_starlight")

    [
      "shoujokageki_revue_starlight_overture",
      "shoujokageki_revue_starlight_the_live_show_must_go_on",
      "shoujokageki_revue_starlight_the_live_2_transition"
    ]
    |> Enum.each(&Sources.add_source("dynasty", 3, &1, "revue_starlight"))
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
    |> Enum.filter(&(not File.exists?(LL.files_root() <> elem(&1, 1))))
  end

  def update_covers() do
    Repo.all(Series)
    |> Kernel.++(Repo.all(Chapter) |> Enum.filter(&(&1.series == nil)))
    |> Enum.each(&LL.Sources.Dynasty.download_cover/1)
  end

  def get_original_files_sizes(chapter_id) do
    root = "https://dynasty-scans.com"

    Repo.get(Chapter, chapter_id)
    |> Map.get(:original_files)
    |> Enum.map(&(root <> &1))
    |> Enum.with_index()
    |> Enum.each(fn {url, n} ->
      Downloader.add(url, :head, fn {:ok, _data, headers} ->
        case headers |> Enum.filter(&(elem(&1, 0) == "Content-Length")) do
          [{"Content-Length", content_length}] ->
            Chapter.update_original_filesize(
              chapter_id,
              n,
              Integer.parse(content_length) |> elem(0)
            )

          _ ->
            nil
        end
      end)
    end)
  end

  def get_original_files() do
    Repo.all(Chapter)
    |> Enum.each(fn chapter ->
      if chapter.original_files_sizes == nil do
        chapter
        |> Sources.Dynasty.chapter_url()
        |> Kernel.<>(".json")
        |> Downloader.add(:get, fn {:ok, data, _resp} ->
          case Jason.decode(data) do
            {:ok, %{"pages" => pages}} ->
              pages = Enum.map(pages, & &1["url"])
              files_sizes = List.duplicate(0, length(pages))

              Chapter.change(chapter, %{original_files: pages, original_files_sizes: files_sizes})
              |> Repo.update()

              get_original_files_sizes(chapter.id)

            _ ->
              nil
          end
        end)
      else
        if Enum.any?(chapter.original_files_sizes, &(&1 == 0)) do
          get_original_files_sizes(chapter.id)
        end
      end
    end)
  end

  def get_filesizes() do
    Repo.all(Chapter)
    |> Enum.each(fn chapter ->
      new_filesize =
        chapter.files
        |> Stream.filter(&(not String.starts_with?(&1, "tmp")))
        |> Stream.filter(&(not String.starts_with?(&1, "/")))
        |> Stream.map(&(LL.files_root() <> &1))
        |> Stream.map(&(File.stat!(&1) |> Map.get(:size)))
        |> Enum.sum()

      Chapter.change(chapter, %{filesize: new_filesize})
      |> Repo.update()
    end)
  end

  def create_category() do
    %LL.Category{
      id: "love_live",
      name: "Love Live!"
    }
    |> Repo.insert()

    %LL.Category{
      id: "bang_dream",
      name: "BanG Dream!"
    }
    |> Repo.insert()
  end

  def add_category() do
    # ll = Repo.get(Category, "love_live")
    bandori = Repo.get(LL.Category, "bang_dream")

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
