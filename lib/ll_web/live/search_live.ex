defmodule LLWeb.SearchLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent
  use LLWeb.SeriesPageComponent
  use LLWeb.ChapterComponent

  alias LL.{ExtensionManager, Repo, Series}

  @topic to_string(__MODULE__)

  def title(), do: "Search"

  def render(assigns) do
    LLWeb.PageView.render("search.html", assigns)
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe(@topic)
      Endpoint.subscribe(@topic <> socket.id)
    end

    sources = LL.SourceManager.get().sources

    form =
      sources
      |> Enum.map(&{"enable_#{&1.id}", true})
      |> Map.new()
      |> Map.merge(%{"query" => ""})
      |> to_form()

    socket =
      socket
      |> assign(topic: @topic <> socket.id)
      |> assign(search: %{id: 0, query: "", page: 1, results: %{}})
      |> assign(search_form: form)
      |> assign(sources: sources)
      |> assign(results: %{})

    {:ok, socket}
  end

  def update_sources(arr) do
    Endpoint.broadcast(@topic, "update_assigns", {:sources, arr})
  end

  def handle_info(%{event: "update_assigns", payload: {key, val}}, socket) do
    socket = assign(socket, key, val)

    {:noreply, socket}
  end

  def handle_info(
        %{
          event: "search_result",
          payload: %{id: search_id, source_id: source_id, results: results}
        },
        socket
      )
      when socket.assigns.search.id == search_id do
    new_results =
      Map.put(socket.assigns.search.results, source_id, results)

    socket = assign(socket, search: %{socket.assigns.search | results: new_results})
    {:noreply, socket}
  end

  def handle_event("search", %{"query" => query} = params, socket) do
    search_id = Ecto.UUID.generate()

    search = %{
      id: search_id,
      query: query,
      page: 1,
      results: %{}
    }

    socket = socket |> assign(search: search)

    socket.assigns.sources
    |> Enum.filter(&Map.get(params, "enable_#{&1.id}"))
    |> Enum.each(fn source ->
      ExtensionManager.search(source, search, fn results ->
        Endpoint.broadcast(socket.assigns.topic, "search_result", %{
          id: search_id,
          source_id: source.source_id,
          results: results
        })
      end)
    end)

    {:noreply, socket}
  end

  def handle_event("select_series", %{"id" => id}, socket) do
    series = Repo.get(Series, id) |> Repo.preload([:source, :chapters])

    socket =
      socket
      |> assign(series: series)
      |> assign(source: series.source)
      |> assign(chapters: series.chapters)

    {:noreply, socket}
  end

  def handle_event("close_series", _, socket) do
    socket = assign(socket, series: nil)

    {:noreply, socket}
  end
end
