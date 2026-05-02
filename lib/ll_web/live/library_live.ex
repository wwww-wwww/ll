defmodule LLWeb.LibraryLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Series}

  def title(), do: "Library"

  def render(assigns) do
    ~H"""
    <input id="filters_chk" type="checkbox" phx-update="ignore" />
    <div class="filters">
      <label for="filters_chk" class="material-symbols-rounded">filter_alt</label>
      <div>
        <div>
          <span>Categories:</span>
          <form phx-change="filter-categories" class="categories">
            <div :for={c <- @categories} class="check">
              <input
                type="checkbox"
                id={"filter-category-#{c.id}"}
                name={"category:#{c.id}"}
                checked={c.id in @filter_categories}
              />
              <label for={"filter-category-#{c.id}"}>{c.name}</label>
            </div>
          </form>
        </div>
      </div>
    </div>

    <div class="library">
      <.live_component
        :for={series <- @library}
        :if={
          length(@filter_categories) == 0 or
            Enum.any?(series.categories, &(&1.id in @filter_categories))
        }
        module={LLWeb.SeriesComponent}
        id={"#{LLWeb.SeriesComponent.id(series.id)}#{if is_multi?(series), do: "-Multi"}"}
        series={series}
        library={true}
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
      |> Repo.preload([:series, :children, :categories])

    library =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Repo.preload(:categories)
      |> Enum.map(&Map.put(&1, :description, ""))

    categories = Repo.all(LL.Category)

    library =
      (library ++ multis)
      |> Enum.sort_by(
        &(Map.get(&1, :series, &1).title
          |> String.downcase())
      )

    socket =
      socket
      |> assign(library: library)
      |> assign(categories: categories)
      |> assign(filter_categories: [])

    {:ok, socket}
  end

  def handle_params(params, _path, socket) do
    socket =
      case Map.get(params, "id") do
        nil ->
          socket |> assign(series_id: nil)

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

  def update() do
    library =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Repo.preload(:categories)
      |> Enum.map(&Map.put(&1, :description, ""))

    multis =
      Repo.all(LL.MultiSeries)
      |> Repo.preload([:series, :children])

    library =
      (library ++ multis)
      |> Enum.sort_by(
        &(Map.get(&1, :series, &1).title
          |> String.downcase())
      )

    Endpoint.broadcast("library", "update", library)
  end

  def handle_info(%{topic: "library", event: "update", payload: library}, socket) do
    {:noreply, assign(socket, library: library)}
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
    {:noreply, push_patch(socket, to: ~p"/")}
  end

  def handle_event("filter-categories", params, socket) do
    categories =
      Enum.reduce(params, [], fn {param, _}, acc ->
        case param do
          "category:" <> id -> acc ++ [Integer.parse(id) |> elem(0)]
          _ -> acc
        end
      end)

    {:noreply, socket |> assign(filter_categories: categories)}
  end
end
