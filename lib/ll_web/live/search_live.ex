defmodule LLWeb.SearchLive do
  use LLWeb, :live_view

  require LL.Downloader
  alias LL.{Downloader, Repo, Series, ExtensionManager}

  @topic to_string(__MODULE__)

  def title(_socket), do: "Search"

  def render(assigns) do
    LLWeb.PageView.render("search.html", assigns)
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe(@topic)
      LLWeb.Endpoint.subscribe(@topic <> socket.id)
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
    LLWeb.Endpoint.broadcast(@topic, "update_assigns", {:sources, arr})
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

  def handle_info(%{topic: "series:" <> _, event: "update", payload: series}, socket) do
    send_update(LLWeb.LibraryCard, id: "series_#{series.id}", series: series)
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

    source =
      socket.assigns.sources
      |> Enum.filter(&Map.get(params, "enable_#{&1.id}"))
      |> Enum.each(fn source ->
        ExtensionManager.search(source, search, fn results ->
          LLWeb.Endpoint.broadcast(socket.assigns.topic, "search_result", %{
            source_id: source.source_id,
            id: search_id,
            results: results
          })
        end)
      end)

    {:noreply, socket}
  end
end
