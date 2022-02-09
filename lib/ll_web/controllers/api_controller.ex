defmodule LLWeb.ApiController do
  use LLWeb, :controller

  alias LL.{Repo, Chapter, Series}

  def all(conn, _params) do
    conn |> json(LL.DB.all_safe())
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
    |> Repo.preload([{:chapters, :tags}, :tags])
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      series ->
        latest_chapter = series.chapters |> Enum.max_by(& &1.date)

        chapters =
          Enum.map(
            series.chapters,
            fn chapter ->
              %{
                id: chapter.id,
                title: chapter.title,
                date: chapter.date,
                number: chapter.number,
                tags: map_tags(chapter.tags)
              }
            end
          )

        conn
        |> json(%{
          success: 1,
          type: "series",
          id: series.id,
          title: series.title,
          description: series.description,
          cover: series.cover,
          date: latest_chapter.date,
          tags: map_tags(series.tags),
          chapters: chapters
        })
    end
  end

  def chapter(conn, %{"chapter_id" => chapter_id}) do
    Repo.get(Chapter, chapter_id)
    |> Repo.preload(:tags)
    |> case do
      nil ->
        conn |> json(%{success: 0, reason: "chapter not found"})

      chapter ->
        conn
        |> json(%{
          success: 1,
          type: "chapter",
          id: chapter.id,
          title: chapter.title,
          number: chapter.number,
          cover: chapter.cover,
          date: chapter.date,
          tags: map_tags(chapter.tags),
          series_id: chapter.series_id,
          files: chapter.files
        })
    end
  end
end
