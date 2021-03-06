defmodule LLWeb.ReaderLive do
  use LLWeb, :live_view

  alias LL.{Repo, Chapter, Series}

  def render(assigns) do
    LLWeb.PageView.render("reader.html", assigns)
  end

  def mount(%{"chapter_id" => chapter_id}, _session, socket) do
    Repo.get(Chapter, chapter_id)
    |> Repo.preload([:tags, :series])
    |> case do
      nil ->
        {:ok,
         redirect(socket, to: "/")
         |> put_flash(:error, "Chapter not found")}

      chapter ->
        {:ok,
         socket
         |> assign(type: :chapter)
         |> assign(title: chapter.title)
         |> assign(tags: chapter.tags)
         |> assign(chapter: chapter)
         |> assign(date: chapter.date)}
    end
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    Repo.get(Series, series_id)
    |> Repo.preload([{:chapters, :tags}, :tags])
    |> case do
      nil ->
        {:ok,
         redirect(socket, to: "/")
         |> put_flash(:error, "Series not found")}

      series ->
        date =
          case series.chapters do
            [] -> series.inserted_at
            chapters -> chapters |> Enum.max_by(& &1.date, Date) |> Map.get(:date)
          end

        chapters = Enum.sort_by(series.chapters, &(&1.number || 0))

        common_tags = chapters |> Enum.map(& &1.tags) |> List.flatten()

        common_tags =
          Enum.reduce(chapters |> Enum.drop(1), common_tags, fn _, acc ->
            acc -- Enum.uniq(common_tags)
          end)

        {:ok,
         socket
         |> assign(type: :series)
         |> assign(series: series)
         |> assign(chapters: chapters)
         |> assign(title: series.title)
         |> assign(tags: common_tags)
         |> assign(date: date)}
    end
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
