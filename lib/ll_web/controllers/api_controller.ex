defmodule LLWeb.ApiController do
  use LLWeb, :controller

  alias LL.{Repo, Chapter, Series, MultiSeries}

  defp thumbnail_url(entry) do
    case LL.Anilist.thumbnail_path(entry) do
      nil -> nil
      path -> ~p"/thumbnail/#{Path.basename(path)}"
    end
  end

  def all(conn, _params) do
    entries =
      LLWeb.MainLibraryLive.main_libraries()
      |> LLWeb.MainLibraryLive.libraries_series()
      |> Enum.map(fn entry ->
        case entry do
          %MultiSeries{series: series} ->
            %{
              url: ~p"/multi/#{entry.id}",
              title: LL.Anilist.title(entry),
              artist: LL.Anilist.field(entry, :artist),
              author: LL.Anilist.field(entry, :author),
              genre: entry.genre,
              status: LL.Anilist.field(entry, :status) || -1,
              thumbnail_url: thumbnail_url(entry),
              multi: true,
              aliases: LL.Anilist.aliases(entry) |> Enum.map(& &1.name)
            }

          series ->
            %{
              url: ~p"/series/#{series.id}",
              title: LL.Anilist.title(series),
              artist: LL.Anilist.field(series, :artist),
              author: LL.Anilist.field(series, :author),
              genre: series.genre,
              status: LL.Anilist.field(series, :status) || -1,
              thumbnail_url: thumbnail_url(series),
              aliases: LL.Anilist.aliases(entry) |> Enum.map(& &1.name)
            }
        end
      end)

    json(conn, entries)
  end

  def all_multi(conn, %{"multi_id" => multi_id}) do
    Repo.get(MultiSeries, multi_id)
    |> Repo.preload([:anilist, series: :source, children: :source])
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      multi ->
        json(conn, [
          %{
            url: ~p"/multi/#{multi.id}",
            title: LL.Anilist.title(multi),
            artist: LL.Anilist.field(multi, :artist),
            author: LL.Anilist.field(multi, :author),
            genre: multi.genre,
            status: LL.Anilist.field(multi, :status) || -1,
            thumbnail_url: thumbnail_url(multi),
            multi: true
          }
        ])
    end
  end

  def all_series(conn, %{"series_id" => series_id}) do
    Repo.get(Series, series_id)
    |> Repo.preload([:anilist, :chapters])
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      series ->
        json(conn, [
          %{
            url: ~p"/series/#{series.id}",
            title: LL.Anilist.title(series),
            artist: LL.Anilist.field(series, :artist),
            author: LL.Anilist.field(series, :author),
            genre: series.genre,
            status: LL.Anilist.field(series, :status) || -1,
            thumbnail_url: thumbnail_url(series)
          }
        ])
    end
  end

  def map_tags(tags) do
    Stream.map(
      tags,
      &%{
        type: &1.type,
        name: &1.name
      }
    )
    |> Enum.sort_by(& &1.name)
  end

  def multi(conn, %{"multi_id" => multi_id}) do
    Repo.get(MultiSeries, multi_id)
    |> Repo.preload([:anilist, series: :source, children: :source])
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      multi ->
        chapters =
          MultiSeries.get_chapters(multi)
          |> Enum.filter(&(Chapter.downloaded?(elem(&1, 1)) and elem(&1, 1).hidden != true))
          |> Enum.map(fn {series, chapter} ->
            source_name = if series.source, do: series.source.name, else: "Local"

            scanlator =
              if chapter.scanlator == nil,
                do: source_name,
                else: "#{source_name} - #{chapter.scanlator}"

            %{
              url: ~p"/series/#{series.id}/#{chapter.id}",
              title: chapter.title || "",
              number: chapter.number,
              date: chapter.date |> DateTime.to_unix() |> Kernel.*(1000),
              scanlator: scanlator
            }
          end)
          |> Enum.uniq_by(& &1.number)

        json(conn, %{
          success: 1,
          url: ~p"/multi/#{multi.id}",
          title: LL.Anilist.title(multi),
          artist: LL.Anilist.field(multi, :artist) || "",
          author: LL.Anilist.field(multi, :author) || "",
          description: LL.Anilist.field(multi, :description),
          genre: multi.series.genre,
          status: LL.Anilist.field(multi, :status) || -1,
          thumbnail_url: thumbnail_url(multi),
          chapters: chapters,
          multi: true
        })
    end
  end

  def series(conn, %{"series_id" => series_id}) do
    Repo.get(Series, series_id)
    |> Repo.preload([:anilist, :chapters])
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      series ->
        chapters =
          series.chapters
          |> Enum.filter(&(Chapter.downloaded?(&1) and &1.hidden != true))
          |> Enum.sort_by(
            fn c ->
              {c.number,
               Regex.scan(~r/\d+\.?\d*/, c.title || "")
               |> List.flatten()
               |> Enum.map(&(Float.parse(&1) |> elem(0)))}
            end,
            :desc
          )
          |> Enum.map(fn chapter ->
            %{
              url: ~p"/series/#{series.id}/#{chapter.id}",
              title: chapter.title || "",
              number: chapter.number,
              date: chapter.date |> DateTime.to_unix() |> Kernel.*(1000),
              scanlator: chapter.scanlator || ""
            }
          end)

        json(conn, %{
          success: 1,
          url: ~p"/series/#{series.id}",
          title: LL.Anilist.title(series),
          artist: LL.Anilist.field(series, :artist) || "",
          author: LL.Anilist.field(series, :author) || "",
          description: LL.Anilist.field(series, :description),
          genre: series.genre,
          status: LL.Anilist.field(series, :status) || -1,
          thumbnail_url: thumbnail_url(series),
          chapters: chapters
        })
    end
  end

  def chapter(conn, %{"chapter_id" => chapter_id}) do
    case Repo.get(Chapter, chapter_id) do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      chapter ->
        files =
          Enum.with_index(chapter.files)
          |> Enum.map(fn {_, i} ->
            ~p"/page/#{chapter.id}/#{i + 1}"
          end)

        json(conn, %{
          success: 1,
          url: ~p"/series/#{chapter.series_id}/#{chapter.id}",
          title: chapter.title || "",
          number: chapter.number,
          date: chapter.date |> DateTime.to_unix(),
          scanlator: chapter.scanlator,
          files: files
        })
    end
  end
end
