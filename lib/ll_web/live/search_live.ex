defmodule LLWeb.SearchLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent

  alias LL.{ExtensionManager}

  def title(), do: "Search"

  def render(assigns) do
    LLWeb.PageView.render("search.html", assigns)
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("sources")
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
      |> assign(results: %{})
      |> assign(search_id: 0)
      |> assign(query: "")
      |> assign(page: 0)
      |> assign(search_form: form)
      |> assign(sources: sources)

    {:ok, socket}
  end

  def handle_info(%{topic: "sources", payload: sources}, socket) do
    {:noreply, assign(socket, sources: sources)}
  end

  def handle_info(
        {:search_result, search_id, source_id, results},
        socket
      )
      when socket.assigns.search_id == search_id do
    {:noreply, assign(socket, results: Map.put(socket.assigns.results, source_id, results))}
  end

  def handle_info({:search_result, _}, socket) do
    {:noreply, socket}
  end

  def handle_event("search", %{"query" => query} = params, socket) do
    search_id = Ecto.UUID.generate()

    new_form =
      socket.assigns.search_form.source
      |> Enum.map(&{elem(&1, 0), Map.get(params, elem(&1, 0)) || false})
      |> Map.new()
      |> to_form()

    filters = []
    page = 1

    socket =
      socket
      |> assign(search_id: search_id)
      |> assign(query: query)
      |> assign(page: page)
      |> assign(results: %{})
      |> assign(search_form: new_form)

    pid = self()

    socket.assigns.sources
    |> Enum.filter(&Map.get(params, "enable_#{&1.id}"))
    |> Enum.each(fn source ->
      ExtensionManager.search(source, query, filters, page, fn results ->
        send(pid, {:search_result, search_id, source.source_id, results})
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
