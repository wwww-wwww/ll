defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view

  require LL.Downloader
  alias LL.{Downloader, Repo, Series}

  def title(_socket), do: "Series"

  def render(assigns) do
    LLWeb.PageView.render("series.html", assigns)
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("series:#{series_id}")
    end

    series =
      Repo.get(Series, series_id)
      |> Repo.preload(source: :extension)
      |> Repo.preload(:tags)

    socket =
      socket
      |> assign(series: series)

    {:ok, socket}
  end

  def handle_info(%{event: "update", payload: series}, socket) do
    socket = assign(socket, series: series)

    {:noreply, socket}
  end

  def handle_event("refresh", _, socket) do
    LL.ExtensionManager.series_details(socket.assigns.series, fn series ->
      LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)
    end)

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
