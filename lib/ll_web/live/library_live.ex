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

        id ->
          case Repo.get(Series, id) do
            nil ->
              socket

            series ->
              assign(socket, series_id: series.id)
          end
      end

    library =
      from(s in Series, where: s.in_library == true)
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

  def handle_info(%{topic: "library", event: "update", payload: library}, socket) do
    socket = assign(socket, library: library)
    {:noreply, socket}
  end
end
