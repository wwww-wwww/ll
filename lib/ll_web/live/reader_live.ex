defmodule LLWeb.ReaderLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  alias LL.{Repo, Chapter}

  def render(assigns) do
    LLWeb.PageView.render("reader.html", assigns)
  end

  def mount(%{"chapter_id" => chapter_id}, _session, socket) do
    Repo.get(Chapter, chapter_id)
    |> Repo.preload([:tags, :series])
    |> case do
      nil ->
        socket =
          socket
          |> redirect(to: "/")
          |> put_flash(:error, "Chapter not found")

        {:ok, socket}

      chapter ->
        chapters = Chapter.list(chapter.series)

        series = chapter.series |> Map.put(:description, "")

        chapter = Map.put(chapter, :series, nil)

        socket =
          socket
          |> assign(page_title: chapter.title)
          |> assign(series: series)
          |> assign(tags: chapter.tags)
          |> assign(chapters: chapters)
          |> assign(chapter: chapter)

        {:ok, socket}
    end
  end
end
