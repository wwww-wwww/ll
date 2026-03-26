defmodule LLWeb.ApiController do
  use LLWeb, :controller

  import Ecto.Query, only: [from: 2]
  alias LL.{Repo, Chapter, Series}

  def all(conn, _params) do
    list =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Enum.map(fn series ->
        %{
          url: Routes.live_path(conn, LLWeb.SeriesLive, series.id),
          title: series.title,
          artist: series.artist,
          author: series.author,
          genre: series.genre,
          status: series.status,
          thumbnail_url:
            Routes.static_path(conn, "/thumbnail/#{Path.basename(series.thumbnail_path)}")
        }
      end)

    json(conn, list)
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

  def series(conn, %{"series_id" => series_id}) do
    Repo.get(Series, series_id)
    |> Repo.preload(:chapters)
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      series ->
        chapters =
          Enum.map(
            series.chapters,
            fn chapter ->
              %{
                url: Routes.live_path(conn, LLWeb.ReaderLive, series.id, chapter.id),
                title: chapter.title,
                number: chapter.number,
                date: chapter.date |> DateTime.to_unix(),
                scanlator: chapter.scanlator
              }
            end
          )
          |> Enum.sort_by(
            fn c ->
              {c.number,
               Regex.scan(~r/\d+\.?\d*/, c.title)
               |> List.flatten()
               |> Enum.map(&(Float.parse(&1) |> elem(0)))}
            end,
            :desc
          )

        conn
        |> json(%{
          success: 1,
          url: Routes.live_path(conn, LLWeb.SeriesLive, series.id),
          title: series.title,
          artist: series.artist,
          author: series.author,
          description: series.description,
          genre: series.genre,
          status: series.status,
          thumbnail_url:
            Routes.static_path(conn, "/thumbnail/#{Path.basename(series.thumbnail_path)}"),
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
            Routes.page_path(conn, :page, chapter.id, i + 1)
          end)

        conn
        |> json(%{
          success: 1,
          url: Routes.live_path(conn, LLWeb.ReaderLive, chapter.series_id, chapter.id),
          title: chapter.title,
          number: chapter.number,
          date: chapter.date |> DateTime.to_unix(),
          scanlator: chapter.scanlator,
          files: files
        })
    end
  end
end
