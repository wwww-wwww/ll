defmodule LLWeb.ReaderLive do
  use LLWeb, :live_view

  alias LL.{Repo, Chapter}

  def render(assigns) do
    LLWeb.PageView.render("reader.html", assigns)
  end

  def mount(%{"chapter_id" => chapter_id}, _session, socket) do
    chapter =
      Repo.get(Chapter, chapter_id)
      |> Repo.preload([:tags, :series])

    cover =
      if chapter.series_id do
        chapter.series.cover
      else
        chapter.cover
      end

    socket =
      socket
      |> assign(type: :chapter)
      |> assign(title: chapter.title)
      |> assign(tags: chapter.tags)
      |> assign(chapter: chapter)
      |> assign(date: chapter.date)

    {:ok, socket}
  end

  def handle_params(_params, _session, socket) do
    {:noreply, socket}
  end
end
