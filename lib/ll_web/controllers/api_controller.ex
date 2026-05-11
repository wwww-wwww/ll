defmodule LLWeb.ApiController do
  use LLWeb, :controller

  import Ecto.Query, only: [from: 2]
  alias LL.{Repo, Chapter, Series, MultiSeries}

  def all(conn, _params) do
    list =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Enum.map(fn series ->
        %{
          url: ~p"/series/#{series.id}",
          title: series.title,
          artist: series.artist,
          author: series.author,
          genre: series.genre,
          status: series.status,
          thumbnail_url: ~p"/thumbnail/#{Path.basename(series.thumbnail_path)}"
        }
      end)

    multis =
      Repo.all(MultiSeries)
      |> Repo.preload(:series)
      |> Enum.map(fn multi ->
        %{
          url: ~p"/series/#{"m" <> multi.id}",
          title: multi.series.title <> " (Multi)",
          artist: multi.series.artist,
          author: multi.series.author,
          genre: multi.series.genre,
          status: multi.series.status,
          thumbnail_url: ~p"/thumbnail/#{Path.basename(multi.series.thumbnail_path)}",
          multi: true
        }
      end)

    json(conn, list ++ multis)
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

  def series(conn, %{"series_id" => "m" <> multi_id}) do
    Repo.get(MultiSeries, multi_id)
    |> Repo.preload(series: :source, children: :source)
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      multi ->
        chapters =
          MultiSeries.get_chapters(multi)
          |> Enum.filter(&(Chapter.downloaded?(elem(&1, 1)) and elem(&1, 1).hidden != true))
          |> Enum.map(fn {series, chapter} ->
            scanlator =
              if chapter.scanlator == nil,
                do: series.source.name,
                else: "#{series.source.name} - #{chapter.scanlator}"

            %{
              url: ~p"/series/#{series.id}/#{chapter.id}",
              title: chapter.title,
              number: chapter.number,
              date: chapter.date |> DateTime.to_unix() |> Kernel.*(1000),
              scanlator: scanlator
            }
          end)
          |> Enum.uniq_by(& &1.number)

        conn
        |> json(%{
          success: 1,
          url: ~p"/series/#{"m" <> multi.id}",
          title: multi.series.title <> " (Multi)",
          artist: multi.series.artist || "",
          author: multi.series.author || "",
          description: multi.series.description,
          genre: multi.series.genre,
          status: multi.series.status,
          thumbnail_url: ~p"/thumbnail/#{Path.basename(multi.series.thumbnail_path)}",
          chapters: chapters,
          multi: true
        })
    end
  end

  def series(conn, %{"series_id" => series_id}) do
    Repo.get(Series, series_id)
    |> Repo.preload(:chapters)
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
               Regex.scan(~r/\d+\.?\d*/, c.title)
               |> List.flatten()
               |> Enum.map(&(Float.parse(&1) |> elem(0)))}
            end,
            :desc
          )
          |> Enum.map(fn chapter ->
            %{
              url: ~p"/series/#{series.id}/#{chapter.id}",
              title: chapter.title,
              number: chapter.number,
              date: chapter.date |> DateTime.to_unix() |> Kernel.*(1000),
              scanlator: chapter.scanlator || ""
            }
          end)

        conn
        |> json(%{
          success: 1,
          url: ~p"/series/#{series.id}",
          title: series.title,
          artist: series.artist || "",
          author: series.author || "",
          description: series.description,
          genre: series.genre,
          status: series.status,
          thumbnail_url: ~p"/thumbnail/#{Path.basename(series.thumbnail_path)}",
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

        conn
        |> json(%{
          success: 1,
          url: ~p"/series/#{chapter.series_id}/#{chapter.id}",
          title: chapter.title,
          number: chapter.number,
          date: chapter.date |> DateTime.to_unix(),
          scanlator: chapter.scanlator,
          files: files
        })
    end
  end
end
