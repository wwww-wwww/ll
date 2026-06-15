defmodule LLWeb.MainLibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, MultiSeries, Series, Library}

  def title(), do: "Home"

  def render(assigns) do
    ~H"""
    <div class="library">
      <.live_component
        :for={entry <- @entries}
        module={LLWeb.SeriesComponent}
        id={"#{LLWeb.SeriesComponent.id(entry.id)}#{if is_multi?(entry), do: "-Multi"}"}
        series={entry}
        href={create_path(entry, assigns[:library])}
        is_multi={is_multi?(entry)}
        in_library={in_library?(entry, @my_library)}
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

  def create_path(%Series{id: id}, nil), do: "/home?series=#{id}"
  def create_path(%MultiSeries{id: id}, nil), do: "/home?multi=#{id}"
  def create_path(%Series{id: id}, %{name: name}), do: "/home/#{name}?series=#{id}"
  def create_path(%MultiSeries{id: id}, %{name: name}), do: "/home/#{name}?multi=#{id}"

  def main_libraries() do
    from(l in Library, where: is_nil(l.user_id))
    |> Repo.all()
    |> Repo.preload([:series, [multi_series: [:series, :children]]])
  end

  def libraries_series(libraries) do
    multi_series =
      libraries
      |> Enum.map(& &1.multi_series)
      |> List.flatten()
      |> Enum.uniq_by(& &1.id)

    series =
      libraries
      |> Enum.map(& &1.series)
      |> List.flatten()
      |> Enum.uniq_by(& &1.id)
      |> Enum.filter(fn series ->
        not Enum.any?(multi_series, fn multi ->
          Enum.any?(multi.children, fn child -> child.id == series.id end)
        end)
      end)

    (series ++ multi_series)
    |> Enum.sort_by(&(&1.title |> String.downcase()))
  end

  def in_library?(entry, my_library) do
    Enum.any?(my_library, &(&1.__struct__ == entry.__struct__ and &1.id == entry.id))
  end

  def mount(%{"library" => library} = params, session, socket) do
    socket =
      from(l in Library, where: is_nil(l.user_id) and l.name == ^library)
      |> Repo.one()
      |> case do
        nil -> socket
        library -> assign(socket, library: library)
      end

    mount(Map.delete(params, "library"), session, socket)
  end

  def mount(params, _session, socket) do
    {:noreply, socket} = handle_params(params, "", socket)

    libraries = main_libraries()

    entries =
      case socket.assigns do
        %{library: %{id: library_id}} -> Enum.filter(libraries, &(&1.id == library_id))
        _ -> libraries
      end
      |> libraries_series()

    assigns = %{socket: socket, libraries: libraries, library: socket.assigns[:library]}

    home_nav = ~H"""
    <.link
      :for={c <- @libraries}
      navigate={~p"/home/#{c.name}"}
      class={if(@library && @library.id == c.id, do: ["active"], else: [])}
    >
      {c.name}
    </.link>
    """

    my_library =
      case socket.assigns.current_scope do
        %{user: %LL.User{} = user} ->
          from(l in Library, where: l.user_id == ^user.id)
          |> Repo.all()
          |> Repo.preload([:series, [multi_series: [:series, :children]]])
          |> Enum.map(&(&1.series ++ &1.multi_series))
          |> List.flatten()
          |> Enum.uniq_by(&{&1.__struct__, &1.id})

        _ ->
          []
      end

    socket =
      socket
      |> assign(home_nav: home_nav)
      |> assign(entries: entries)
      |> assign(libraries: libraries)
      |> assign(my_library: my_library)

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
    {:noreply, push_patch(socket, to: ~p"/")}
  end
end
