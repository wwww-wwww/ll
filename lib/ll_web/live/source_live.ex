defmodule LLWeb.SourceLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent

  require LL.Downloader

  alias LL.{Repo, Extension, Source, ExtensionManager}

  @topic to_string(__MODULE__)

  def title(), do: "Source"

  def render(assigns) do
    ~H"""
    <div class="left">
      <h1>{@source.name}</h1>
      <.form for={@search_form} phx-submit="search">
        <div>
          <input type="text" id={@search_form[:query].id} name={@search_form[:query].name} />
          {submit("Search")}
        </div>
      </.form>

      <div class="library">
        <%= for series <- @search.results do %>
          <.live_component
            module={LLWeb.SeriesComponent}
            id={LLWeb.SeriesComponent.id(series.id)}
            series={series}
          />
        <% end %>
      </div>
    </div>

    <%= if assigns[:series_id] do %>
      <.live_component
        module={LLWeb.SeriesPageComponent}
        id={LLWeb.SeriesPageComponent.id(@series_id)}
        series_id={@series_id}
      />
    <% end %>
    """
  end

  def mount(%{"source" => id}, _session, socket) do
    source = Repo.get(Source, id) |> Repo.preload(:extension)

    form =
      %{"query" => ""}
      |> to_form()

    socket =
      socket
      |> assign(source: source)
      |> assign(search: %{id: 0, query: "", page: 1, results: []})
      |> assign(search_form: form)

    {:ok, socket}
  end

  def handle_info({:search_result, %{id: search_id, results: results}}, socket)
      when socket.assigns.search.id == search_id do
    {:noreply, assign(socket, search: %{socket.assigns.search | results: results})}
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

    ExtensionManager.search(socket.assigns.source, search, fn results ->
      send(pid, {:search_result, %{id: search_id, results: results}})
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
