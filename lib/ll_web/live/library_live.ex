defmodule LLWeb.LibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Series, Repo}

  @limit 20

  def title(_socket), do: "Library"

  def render(assigns) do
    LLWeb.PageView.render("library.html", assigns)
  end

  def mount(_params, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("library")
    end

    library =
      from(s in Series,
        where: s.in_library == true
      )
      |> Repo.all()

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
end
