defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]
  alias LL.{Repo, Series, Chapter}

  def title(), do: "Series"

  def render(assigns) do
    LLWeb.PageView.render("series.html", assigns)
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("series:#{series_id}")
      Endpoint.subscribe("chapters:#{series_id}")
    end

    series =
      Repo.get(Series, series_id)
      |> Repo.preload(source: :extension)

    source = series.source
    tags = series.tags

    chapters =
      from(c in Chapter, where: c.series_id == ^series.id)
      |> Repo.all()

    socket =
      socket
      |> assign(series: series)
      |> assign(source: source)
      |> assign(chapters: chapters)
      |> assign(page_title: series.title)

    if series.details_updated == nil do
      LL.ExtensionManager.series_details(series)
    end

    if series.chapters_updated == nil do
      LL.ExtensionManager.series_chapters(series)
    end

    {:ok, socket}
  end

  def handle_info(%{topic: "series" <> _, event: "update", payload: series}, socket),
    do: {:noreply, assign(socket, series: series)}

  def handle_info(%{topic: "chapters" <> _, event: "update", payload: chapters}, socket),
    do: {:noreply, assign(socket, chapters: chapters)}

  def handle_event("refresh", _, socket) do
    LL.ExtensionManager.series_details(socket.assigns.series)
    {:noreply, socket}
  end

  def handle_event("refresh_chapters", _, socket) do
    LL.ExtensionManager.series_chapters(socket.assigns.series)
    {:noreply, socket}
  end

  def handle_event("library_add", _, socket) do
    {:ok, series} =
      Repo.transact(fn ->
        Repo.get(Series, socket.assigns.series.id)
        |> Ecto.Changeset.change(%{in_library: true})
        |> Repo.update()
      end)

    series =
      series
      |> Repo.preload(source: :extension)
      |> Repo.preload(:tags)

    Endpoint.broadcast("series:#{series.id}", "update", series)

    LLWeb.LibraryLive.update()

    {:noreply, socket}
  end

  def handle_event("library_remove", _, socket) do
    {:ok, series} =
      Repo.transact(fn ->
        Repo.get(Series, socket.assigns.series.id)
        |> Ecto.Changeset.change(%{in_library: false})
        |> Repo.update()
      end)

    series =
      series
      |> Repo.preload(source: :extension)
      |> Repo.preload(:tags)

    Endpoint.broadcast("series:#{series.id}", "update", series)

    LLWeb.LibraryLive.update()

    {:noreply, socket}
  end

  def handle_event("download_chapter", %{"value" => chapter_id}, socket) do
    Repo.get(Chapter, chapter_id)
    |> LL.ExtensionManager.chapter_pages(socket.assigns.source)

    {:noreply, socket}
  end
end
