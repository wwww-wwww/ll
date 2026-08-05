defmodule LLWeb.SearchLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent

  alias LL.{ExtensionManager}

  def title(), do: "Search"

  def render(assigns) do
    ~H"""
    <div class="left">
      <h1>Search</h1>

      <.link navigate={~p"/admin/extensions"}>Extensions</.link>

      <.form for={@search_form} phx-submit="search">
        <div>
          <input
            type="text"
            id={@search_form[:query].id}
            name={@search_form[:query].name}
            value={@search_form[:query].value}
          />
          <input type="submit" value="Search" />
        </div>

        <div class="sources">
          <%= for source <- @sources do %>
            <% field = @search_form["enable_#{source.id}"] %>
            <div>
              <input type="checkbox" id={field.id} name={field.name} checked={field.value} />
              <.link navigate={~p"/admin/search/#{source.id}"}>
                <img
                  loading="lazy"
                  src={"#{LL.ExtensionManager.extension_repo()}icon/#{source.extension.pkg}.png"}
                />
                <span>{source.name}</span>
                <span>{source.lang}</span>
              </.link>
            </div>
          <% end %>
        </div>
      </.form>

      <%= for {source_id, results} <- @results do %>
        <div>
          <h4>
            {@sources |> Enum.filter(&(&1.source_id == source_id)) |> Enum.at(0) |> Map.get(:name)}
          </h4>
          <div class="library">
            <%= for series <- results do %>
              <.live_component
                module={LLWeb.SeriesComponent}
                id={LLWeb.SeriesComponent.id(series.id)}
                series={series}
                href={~p"/series/#{series.id}"}
                select={true}
              />
            <% end %>
          </div>
        </div>
      <% end %>
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

  def mount(_, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("sources")
    end

    sources =
      LL.SourceManager.get().sources
      |> Enum.filter(&(&1.lang == "all" or &1.lang == "en"))

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
    sources = sources |> Enum.filter(&(&1.lang == "all" or &1.lang == "en"))
    {:noreply, assign(socket, sources: sources)}
  end

  def handle_info({:search_result, search_id, source_id, results}, socket)
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
      ExtensionManager.search(source, query, filters, page, fn results, _has_next ->
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
