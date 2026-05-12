defmodule LLWeb.LibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, MultiSeries, Series, Category}

  def title(), do: "Library"

  def render(assigns) do
    ~H"""
    <div class="library">
      <.live_component
        :for={series <- @library}
        module={LLWeb.SeriesComponent}
        id={"#{LLWeb.SeriesComponent.id(series.id)}#{if is_multi?(series), do: "-Multi"}"}
        series={series}
        library={true}
        category={assigns[:category]}
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

  def mount(%{"category" => category} = params, session, socket) do
    socket =
      case Repo.get_by(Category, name: category) do
        nil -> socket
        category -> assign(socket, category: category)
      end

    mount(Map.delete(params, "category"), session, socket)
  end

  def mount(params, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("library")
      Endpoint.subscribe("categories")
    end

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

    library_nav = ~H"""
    <div class="sub">
      <.link
        :for={c <- @categories}
        navigate={~p"/library/category/#{c.name}"}
        class={if(@category && @category.id == c.id, do: ["active"], else: [])}
      >
        {c.name}
      </.link>
    </div>
    """

    socket =
      socket
      |> assign(library_nav: library_nav)
      |> assign(library: library)
      |> assign(categories: categories)

    {:ok, socket}
  end

  def handle_params(%{"multi_id" => series_id}, _path, socket) do
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

  def handle_params(%{"series_id" => series_id}, _path, socket) do
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

  def update() do
    library =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Repo.preload(:categories)
      |> Enum.map(&Map.put(&1, :description, ""))

    multis = Repo.all(LL.MultiSeries) |> Repo.preload([:series, :children])

    library =
      (library ++ multis)
      |> Enum.sort_by(&(Map.get(&1, :series, &1).title |> String.downcase()))

    Endpoint.broadcast("library", "update", library)
  end

  def handle_info(%{topic: "library", event: "update", payload: library}, socket) do
    library =
      Enum.filter(library, fn series ->
        socket.assigns[:category] == nil or
          Enum.any?(series.categories, &(&1.id == socket.assigns.category.id))
      end)

    {:noreply, assign(socket, library: library)}
  end

  def handle_info(%{topic: "categories", event: "update", payload: categories}, socket) do
    {:noreply, assign(socket, categories: categories)}
  end

  def handle_event("select_series", params, socket) do
    handle_params(params, "", socket)
  end

  def handle_event("close_series", _, socket) do
    {:noreply, push_patch(socket, to: ~p"/")}
  end
end
