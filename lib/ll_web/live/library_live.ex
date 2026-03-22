defmodule LLWeb.LibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.SeriesPageComponent
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Series, Chapter}

  @limit 20

  def title(), do: "Library"

  def render(assigns) do
    LLWeb.PageView.render("library.html", assigns)
  end

  def mount(params, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("library")
    end

    socket =
      case Map.get(params, "id") do
        nil ->
          socket

        id ->
          Repo.get(Series, id)
          |> Repo.preload(source: :extension)
          |> case do
            nil ->
              socket

            series ->
              series = Map.put(series, :description, "")

              chapters =
                from(c in Chapter, where: c.series_id == ^series.id)
                |> Repo.all()

              socket
              |> assign(series: series)
              |> assign(source: series.source)
              |> assign(chapters: chapters)
              |> assign(page_title: series.title)
          end
      end

    library =
      from(s in Series,
        where: s.in_library == true
      )
      |> Repo.all()
      |> Enum.map(&Map.put(&1, :description, ""))

    socket =
      socket
      |> assign(library: library)

    {:ok, socket}
  end

  def update() do
    library =
      from(s in Series,
        where: s.in_library == true
      )
      |> Repo.all()

    Endpoint.broadcast("library", "update", library)
  end

  def handle_info(%{event: "update", payload: library}, socket) do
    socket = assign(socket, library: library)
    {:noreply, socket}
  end

  def handle_event("download_chapter", %{"value" => chapter_id}, socket) do
    Repo.get(Chapter, chapter_id)
    |> LL.ExtensionManager.chapter_pages(socket.assigns.source)

    {:noreply, socket}
  end
end
