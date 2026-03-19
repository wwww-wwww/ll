defmodule LLWeb.SearchLive do
  use LLWeb, :live_view

  require LL.Downloader
  alias LL.{Downloader, Repo}

  @topic to_string(__MODULE__)

  def title(), do: "Search"

  def render(assigns) do
    LLWeb.PageView.render("search.html", assigns)
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe(@topic)
      LLWeb.Endpoint.subscribe(@topic <> socket.id)
    end

    sources = LL.SourceManager.get().sources

    socket =
      socket
      |> assign(search: %{query: "", page: 0, id: 0, results: %{}})
      |> assign(sources: sources)
      |> assign(enabled_sources: sources |> Enum.map(& &1.id))
      |> assign(results: %{})

    {:ok, socket}
  end

  def update_sources(arr) do
    LLWeb.Endpoint.broadcast(@topic, "update_assigns", {:sources, arr})
  end

  def handle_info(%{topic: @topic, event: "update_assigns", payload: {key, val}}, socket) do
    socket = assign(socket, key, val)

    {:noreply, socket}
  end

  def handle_info(
        %{
          topic: @topic <> socket_id,
          event: "search_result",
          payload: %{id: search_id, source_id: source_id, results: results}
        },
        socket
      )
      when socket.id == socket_id and socket.assigns.search.id == search_id do
    new_results = Map.put(socket.assigns.results, source_id, results)
    socket = assign(socket, search: %{socket.assigns.search | results: new_results})
    {:noreply, socket}
  end

  def handle_event("search", %{"query" => query}, socket) do
    source =
      socket.assigns.sources
      |> Enum.filter(&(&1.id in socket.assigns.enabled_sources))
      |> Enum.at(0)

    search_id = Ecto.UUID.generate()
    socket = socket |> assign(search: %{socket.assigns.search | query: query, id: search_id})

    %{
      extension: source.extension.path,
      source: source.source_id,
      query: query
    }
    |> Jason.encode!()
    |> Downloader.post "http://localhost:8000/search", :local do
      {:ok, body, _headers} ->
        with {:ok, j} <- Jason.decode(body) do
          LLWeb.Endpoint.broadcast(@topic <> socket.id, "search_result", %{
            source_id: source.source_id,
            id: search_id,
            results: j
          })
        else
          err -> IO.inspect(err)
        end
    end

    {:noreply, socket}
  end
end
