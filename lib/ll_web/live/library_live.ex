defmodule LLWeb.LibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Series}

  def title(), do: "Library"

  def render(assigns) do
    LLWeb.PageView.render("library.html", assigns)
  end

  def mount(params, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("library")
      Endpoint.subscribe("categories")
    end

    socket =
      case Map.get(params, "id") do
        nil ->
          socket

        "m" <> id ->
          case Repo.get(LL.MultiSeries, id) do
            nil ->
              socket

            multi ->
              socket
              |> assign(is_multi: true)
              |> assign(series_id: multi.id)
          end

        id ->
          case Repo.get(Series, id) do
            nil ->
              socket

            series ->
              socket
              |> assign(is_multi: false)
              |> assign(series_id: series.id)
          end
      end

    multis =
      Repo.all(LL.MultiSeries)
      |> Repo.preload([:series, :children])

    library =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Repo.preload(:categories)
      |> Enum.map(&Map.put(&1, :description, ""))

    categories = Repo.all(LL.Category)

    socket =
      socket
      |> assign(library: library)
      |> assign(multis: multis)
      |> assign(categories: categories)

    {:ok, socket}
  end

  def update() do
    library =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Repo.preload(:categories)
      |> Enum.map(&Map.put(&1, :description, ""))

    multis =
      Repo.all(LL.MultiSeries)
      |> Repo.preload([:series, :children])

    Endpoint.broadcast("library", "update", {library, multis})
  end

  def handle_info(%{topic: "library", event: "update", payload: {library, multis}}, socket) do
    socket =
      socket
      |> assign(library: library)
      |> assign(multis: multis)

    {:noreply, socket}
  end

  def handle_info(%{topic: "categories", event: "update", payload: categories}, socket) do
    {:noreply, assign(socket, categories: categories)}
  end

  def handle_event("select_series", %{"id" => id}, socket) do
    socket =
      case id do
        nil ->
          socket

        "m" <> id ->
          case Repo.get(LL.MultiSeries, id) do
            nil ->
              socket

            multi ->
              socket
              |> assign(is_multi: true)
              |> assign(series_id: multi.id)
          end

        id ->
          case Repo.get(Series, id) do
            nil ->
              socket

            series ->
              socket
              |> assign(is_multi: false)
              |> assign(series_id: series.id)
          end
      end

    {:noreply, socket}
  end

  def handle_event("close_series", _, socket) do
    {:noreply, assign(socket, series_id: nil)}
  end
end
