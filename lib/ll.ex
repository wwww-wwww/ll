defmodule LL do
  @moduledoc """
  LL keeps the contexts that define your domain
  and business logic.

  Contexts are also responsible for managing your data, regardless
  if it comes from the database, an external API or others.
  """

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Downloader, Chapter, Series}

  def files_root(), do: Application.get_env(:ll, :files_root)

  def sync_all() do
    # downloader = Downloader.get()

    # if length(downloader.working) == 0 and :queue.len(downloader.queue) == 0 do
      #sync_assoc()
      #update_covers()
      #sync_pages()
    #   sync()
    # end
  end

  def test2() do
    Repo.get(Chapter, "meteoroid_ch01")
    |> case do
      nil -> nil
      s -> Repo.delete(s)
    end

    Repo.get(Chapter, "meteoroid_ch02")
    |> case do
      nil -> nil
      s -> Repo.delete(s)
    end

    Repo.get(Series, "meteoroid_ch02")
    |> case do
      nil -> nil
      s -> Repo.delete(s)
    end
  end

  def sync() do

  end

  def sync_pages() do
    # Repo.all(Chapter)
    # |> Enum.map(fn c ->
    #   Sources.Dynasty.download_pages(c)
    # end)
    # |> List.flatten()
    # |> Downloader.save_all()
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
    |> Kernel.++(Repo.all(Chapter))
    # |> Enum.each(&LL.Sources.Dynasty.download_cover/1)
  end

  def get_original_files_sizes(chapter_id) do
    # root = "https://dynasty-scans.com"

    # Repo.get(Chapter, chapter_id)
    # |> Map.get(:original_files)
    # |> Enum.map(&(root <> &1))
    # |> Enum.with_index()
    # |> Enum.each(fn {url, n} ->
    #   Downloader.add(url, :head, fn {:ok, _data, headers} ->
    #     case headers |> Enum.filter(&(elem(&1, 0) == "Content-Length")) do
    #       [{"Content-Length", content_length}] ->
    #         Chapter.update_original_filesize(
    #           chapter_id,
    #           n,
    #           Integer.parse(content_length) |> elem(0)
    #         )

    #       _ ->
    #         nil
    #     end
    #   end)
    # end)
  end

  # def get_original_files() do
  #   Repo.all(Chapter)
  #   |> Enum.each(fn chapter ->
  #     if chapter.original_files_sizes == nil do
  #       chapter
  #       |> Sources.Dynasty.chapter_url()
  #       |> Kernel.<>(".json")
  #       |> Downloader.add(:get, fn {:ok, data, _resp} ->
  #         case Jason.decode(data) do
  #           {:ok, %{"pages" => pages}} ->
  #             pages = Enum.map(pages, & &1["url"])
  #             files_sizes = List.duplicate(0, length(pages))

  #             Chapter.change(chapter, %{original_files: pages, original_files_sizes: files_sizes})
  #             |> Repo.update()

  #             get_original_files_sizes(chapter.id)

  #           _ ->
  #             nil
  #         end
  #       end)
  #     else
  #       if Enum.any?(chapter.original_files_sizes, &(&1 == 0)) do
  #         get_original_files_sizes(chapter.id)
  #       end
  #     end
  #   end)
  # end

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

  def fix_series_paths() do
    Repo.all(Chapter)
    |> Repo.preload(:series)
    |> Enum.filter(&(&1.series != nil))
    |> Enum.each(fn chapter ->
      chapter.files
      |> Enum.with_index()
      |> Enum.each(fn {file, n} ->
        if not String.starts_with?(file, Path.join("files/dynasty", chapter.series.id)) and
             not String.starts_with?(file, "tmp") do
          new_path =
            Path.join("files/dynasty", chapter.series.id)
            |> Path.join(chapter.id)
            |> Path.join(Path.basename(file))

          ch2 = Repo.get(Chapter, chapter.id)
          new_files = Enum.take(ch2.files, n) ++ [new_path] ++ Enum.drop(ch2.files, n + 1)

          IO.inspect("#{file} -> #{new_path}")

          Path.join(files_root(), new_path)
          |> Path.dirname()
          |> File.mkdir_p()

          File.rename(Path.join(files_root(), file), Path.join(files_root(), new_path))
          |> case do
            :ok ->
              Chapter.change(ch2, %{files: new_files})
              |> Repo.update()

            err ->
              IO.inspect(err)
          end
        end
      end)
    end)
  end

  def stats() do
    series =
      Repo.all(Series)
      |> Repo.preload([:tags, {:chapters, :tags}])

    chapters =
      Repo.all(from(u in Chapter, where: is_nil(u.series_id)))
      |> Repo.preload(:tags)

    series_chapters =
      series
      |> Enum.map(& &1.chapters)
      |> List.flatten()

    (chapters ++ series_chapters)
    |> Enum.map(fn chapter ->
      chapter.files
      |> Enum.map(&Path.join(LL.files_root(), &1))
      |> Enum.zip(chapter.original_files_sizes)
      |> Enum.filter(&(elem(&1, 0) |> File.exists?()))
      |> Enum.map(&{elem(&1, 0), elem(&1, 1) / Map.get(File.stat!(elem(&1, 0)), :size)})
    end)
    |> List.flatten()
  end

  def update_series(series) do
    # Sources.source_module(series.source).update(series)
  end

  def sync_series() do
    # downloader = Downloader.get()

    # if length(downloader.working) == 0 and :queue.len(downloader.queue) == 0 do
    #   Repo.all(Series) |> Repo.preload(:tags) |> Enum.each(&update_series/1)
    # end
  end

  def sync_chapters() do
    # Repo.all(Chapter)
    # |> Enum.filter(
    #   &(NaiveDateTime.diff(DateTime.now!("Etc/UTC") |> DateTime.to_naive(), &1.updated_at) > 3600)
    # )
    # |> Enum.each(&Sources.source_module(&1.source).update(&1))
  end
end
