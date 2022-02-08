defmodule LLWeb.ApiController do
  use LLWeb, :controller

  alias LL.{Repo, Chapter, Series}

  def all(conn, _params) do
    conn |> json(LL.DB.all_safe())
  end

  def series(conn, %{"series_id" => series_id, "file" => file}) do
    Path.extname(file)
    |> case do
      ".json" ->
        Repo.get(Series, series_id)
        |> Repo.preload([{:chapters, :tags}, :tags])
        |> case do
          nil ->
            conn |> json(%{success: 0, reason: "chapter not found"})

          series ->
            latest_chapter = series.chapters |> Enum.max_by(& &1.date)

            conn
            |> json(%{
              success: 1,
              id: series.id,
              title: series.title,
              description: series.description,
              cover: series.cover,
              date: latest_chapter.date,
              tags:
                Enum.map(
                  series.tags,
                  &%{
                    type: &1.type,
                    name: &1.name
                  }
                ),
              chapters:
                Enum.map(
                  series.chapters,
                  &%{
                    id: &1.id,
                    title: &1.title,
                    date: &1.date,
                    number: &1.number,
                    tags: Enum.map(&1.tags, fn tag -> %{type: tag.type, name: tag.name} end)
                  }
                )
            })
        end

      _ ->
        conn |> text("not supported")
    end
  end

  def chapter(conn, %{"chapter_id" => chapter_id, "file" => file}) do
    Path.extname(file)
    |> case do
      ".json" ->
        Repo.get(Chapter, chapter_id)
        |> Repo.preload(:tags)
        |> case do
          nil ->
            conn |> json(%{success: 0, reason: "chapter not found"})

          chapter ->
            conn
            |> json(%{
              success: 1,
              id: chapter.id,
              title: chapter.title,
              number: chapter.number,
              cover: chapter.cover,
              date: chapter.date,
              tags:
                Enum.map(
                  chapter.tags,
                  &%{
                    type: &1.type,
                    name: &1.name
                  }
                ),
              series_id: chapter.series_id,
              files: chapter.files
            })
        end

      _ ->
        conn |> text("not supported")
    end
  end
end
