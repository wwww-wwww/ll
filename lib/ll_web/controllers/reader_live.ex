defmodule LLWeb.ReaderLive do
  use LLWeb, :live_view

  alias LL.{Repo, Chapter, Series}

  def render(assigns) do
    LLWeb.PageView.render("reader.html", assigns)
  end

  def mount(%{"chapter_id" => chapter_id}, _session, socket) do
    chapter =
      Repo.get(Chapter, chapter_id)
      |> Repo.preload([:tags, :series])

    socket =
      socket
      |> assign(type: :chapter)
      |> assign(title: chapter.title)
      |> assign(tags: chapter.tags)
      |> assign(chapter: chapter)
      |> assign(date: chapter.date)

    {:ok, socket}
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    series =
      Repo.get(Series, series_id)
      |> Repo.preload([:chapters, :tags])

    latest_chapter = series.chapters |> Enum.max_by(& &1.date)

    chapters = Enum.sort_by(series.chapters, & &1.number)

    socket =
      socket
      |> assign(type: :series)
      |> assign(series: series)
      |> assign(chapters: chapters)
      |> assign(title: series.title)
      |> assign(tags: series.tags)
      |> assign(date: latest_chapter.date)

    {:ok, socket}
  end

  def handle_params(%{"series_id" => _, "n" => n}, _session, socket) do
    series = socket.assigns[:series]

    {n, _} = Integer.parse(n)

    chapter =
      series.chapters
      |> Enum.filter(&(&1.number == n))
      |> Enum.at(0)

    socket =
      socket
      |> assign(chapter: chapter)

    {:noreply, socket}
  end

  def handle_params(_params, _session, socket) do
    {:noreply, socket}
  end
end
