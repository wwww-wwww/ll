defmodule LLWeb.MainLibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, MultiSeries, Series, Category}

  def title(), do: "Library0"

  def render(assigns) do
    ~H"""
    <div class="library">
      <.live_component
        :for={series <- @library}
        module={LLWeb.SeriesComponent}
        id={"#{LLWeb.SeriesComponent.id(series.id)}#{if is_multi?(series), do: "-Multi"}"}
        series={series}
        href={create_path(series, assigns[:category])}
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

  def create_path(%Series{id: id}, nil), do: "/home?series=#{id}"
  def create_path(%MultiSeries{id: id}, nil), do: "/home?multi=#{id}"
  def create_path(%Series{id: id}, %{name: name}), do: "/home/#{name}?series=#{id}"
  def create_path(%MultiSeries{id: id}, %{name: name}), do: "/home/#{name}?multi=#{id}"

  def mount(%{"category" => category} = params, session, socket) do
    socket =
      case Repo.get_by(Category, name: category) do
        nil -> socket
        category -> assign(socket, category: category)
      end

    mount(Map.delete(params, "category"), session, socket)
  end

  def mount(params, _session, socket) do
    {:noreply, socket} = handle_params(params, "", socket)

    library =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Repo.preload(:categories)
      |> Enum.map(&Map.put(&1, :description, ""))

    multis = Repo.all(LL.MultiSeries) |> Repo.preload([:series, :children, :categories])

    library =
      (library ++ multis)
      |> Enum.filter(fn series ->
        socket.assigns[:category] == nil or
          Enum.any?(series.categories, &(&1.id == socket.assigns.category.id))
      end)
      |> Enum.sort_by(&(Map.get(&1, :series, &1).title |> String.downcase()))

    categories = Repo.all(Category)

    assigns = %{socket: socket, categories: categories, category: socket.assigns[:category]}

    home_nav = ~H"""
    <div class="sub">
      <.link
        :for={c <- @categories}
        navigate={~p"/home/#{c.name}"}
        class={if(@category && @category.id == c.id, do: ["active"], else: [])}
      >
        {c.name}
      </.link>
    </div>
    """

    socket =
      socket
      |> assign(home_nav: home_nav)
      |> assign(library: library)
      |> assign(categories: categories)

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
