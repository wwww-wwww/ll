defmodule LLWeb.SearchLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent

  alias LL.{ExtensionManager, Repo, Series}

  def title(), do: "Search"

  def render(assigns) do
    LLWeb.PageView.render("search.html", assigns)
  end

  def mount(_, _session, socket) do
    sources = LL.SourceManager.get().sources

    form =
      sources
      |> Enum.map(&{"enable_#{&1.id}", true})
      |> Map.new()
      |> Map.merge(%{"query" => ""})
      |> to_form()

    socket =
      socket
      |> assign(search: %{id: 0, query: "", page: 1, results: %{}})
      |> assign(search_form: form)
      |> assign(sources: sources)

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
        {:search_result, %{id: search_id, source_id: source_id, results: results}},
        socket
      )
      when socket.assigns.search.id == search_id do
    new_results = Map.put(socket.assigns.search.results, source_id, results)
    socket = assign(socket, search: %{socket.assigns.search | results: new_results})
    {:noreply, socket}
  end

  def handle_info({:search_result, _}, socket) do
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

    pid = self()

    socket.assigns.sources
    |> Enum.filter(&Map.get(params, "enable_#{&1.id}"))
    |> Enum.each(fn source ->
      ExtensionManager.search(source, search, fn results ->
        send(
          pid,
          {:search_result, %{id: search_id, source_id: source.source_id, results: results}}
        )
      end)
    end)

    {:noreply, socket}
  end

  def handle_event("select_series", %{"id" => id}, socket) do
    {:noreply, assign(socket, series_id: id)}
  end

  def handle_event("close_series", _, socket) do
    {:noreply, assign(socket, series_id: nil)}
  end
end
