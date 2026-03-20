defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view

  import Ecto.Query, only: [from: 2]
  require LL.Downloader
  alias LL.{Downloader, Repo, Series, Chapter}

  def title(_socket), do: "Series"

  def render(assigns) do
    LLWeb.PageView.render("series.html", assigns)
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("series:#{series_id}")
      LLWeb.Endpoint.subscribe("chapters:#{series_id}")
    end

    series =
      Repo.get(Series, series_id)
      |> Repo.preload(source: :extension)
      |> Repo.preload(:tags)

    chapters =
      from(c in Chapter, where: c.series_id == ^series.id)
      |> Repo.all()

    socket =
      socket
      |> assign(series: series)
      |> assign(chapters: chapters)

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

    LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

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

    LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

    LLWeb.LibraryLive.update()

    {:noreply, socket}
  end
end
