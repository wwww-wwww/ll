defmodule LLWeb.LibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Library, MultiSeries, Series}

  def title(), do: "Library"

  def render(assigns) do
    ~H"""
    <div class="library">
      <.live_component
        :for={series <- @entries}
        module={LLWeb.SeriesComponent}
        id={"#{LLWeb.SeriesComponent.id(series.id)}#{if is_multi?(series), do: "-Multi"}"}
        series={series}
        href={create_path(series, assigns[:library])}
        is_multi={is_multi?(series)}
      />
    </div>

    <.live_component
      :if={assigns[:series_id]}
      module={LLWeb.SeriesPageComponent}
      id={LLWeb.SeriesPageComponent.id(@series_id)}
      series_id={@series_id}
      is_multi={@is_multi}
    />
    """
  end

  def create_path(%Series{id: id}, nil), do: "/library?series=#{id}"
  def create_path(%MultiSeries{id: id}, nil), do: "/library?multi=#{id}"
  def create_path(%Series{id: id}, %{name: name}), do: "/library/#{name}?series=#{id}"
  def create_path(%MultiSeries{id: id}, %{name: name}), do: "/library/#{name}?multi=#{id}"

  def mount(%{"library" => library} = params, session, socket) do
    socket =
      case Repo.get_by(Library, name: library, user_id: socket.assigns.current_scope.user.id) do
        nil -> socket
        library -> assign(socket, library: library)
      end

    mount(Map.delete(params, "library"), session, socket)
  end

  def mount(params, _session, socket) do
    {:noreply, socket} = handle_params(params, "", socket)

    user = socket.assigns.current_scope.user

    libraries =
      from(l in Library, where: l.user_id == ^user.id)
      |> Repo.all()
      |> Repo.preload([:series, [multi_series: [:series, :children]]])

    entries =
      case socket.assigns do
        %{library: %{id: library_id}} -> Enum.filter(libraries, &(&1.id == library_id))
        _ -> libraries
      end
      |> Enum.map(&(&1.series ++ &1.multi_series))
      |> List.flatten()
      |> Enum.uniq_by(&{&1.__struct__, &1.id})
      |> Enum.sort_by(&(Map.get(&1, :series, &1).title |> String.downcase()))

    assigns = %{socket: socket, libraries: libraries, library: socket.assigns[:library]}

    library_nav = ~H"""
    <.link
      :for={c <- @libraries}
      navigate={~p"/library/#{c.name}"}
      class={if(@library && @library.id == c.id, do: ["active"], else: [])}
    >
      {c.name}
    </.link>
    """

    socket =
      socket
      |> assign(library_nav: library_nav)
      |> assign(entries: entries)
      |> assign(libraries: libraries)

    {:ok, socket}
  end

  def handle_params(%{"multi" => series_id}, _path, socket) do
    socket =
      case Repo.get(MultiSeries, series_id) do
        nil ->
          assign(socket, series_id: nil)

        series ->
          socket
          |> assign(is_multi: true)
          |> assign(series_id: series.id)
      end

    {:noreply, socket}
  end

  def handle_params(%{"series" => series_id}, _path, socket) do
    socket =
      case Repo.get(Series, series_id) do
        nil ->
          assign(socket, series_id: nil)

        series ->
          socket
          |> assign(is_multi: false)
          |> assign(series_id: series.id)
      end

    {:noreply, socket}
  end

  def handle_params(_params, _path, socket) do
    {:noreply, assign(socket, series_id: nil)}
  end

  def handle_event("close_series", _, socket) do
    {:noreply, push_patch(socket, to: ~p"/library")}
  end
end
