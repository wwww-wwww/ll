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
      |> Enum.map(&Map.put(&1, :description, ""))

    socket =
      socket
      |> assign(library: library)
      |> assign(multis: multis)

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

  def handle_info(%{topic: "library", event: "update", payload: library}, socket) do
    socket = assign(socket, library: library)
    {:noreply, socket}
  end
end
