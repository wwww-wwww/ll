defmodule LLWeb.SourceLive do
  use LLWeb, :live_view
  use LLWeb.SeriesComponent

  require LL.Downloader

  alias LL.{Repo, Source, ExtensionManager}

  def title(), do: "Source"

  def render(assigns) do
    ~H"""
    <div class="left">
      <h1>{@source.name}</h1>
      <.form for={@search_form} phx-submit="search">
        <div>
          <input
            type="text"
            id={@search_form[:query].id}
            name={@search_form[:query].name}
            value={@search_form[:query].value}
          />
          {submit("Search")}
        </div>

        <div class="filters">
          <%= for filter <- @filters do %>
            {render_filter(@search_form, filter)}
          <% end %>
        </div>
      </.form>

      <div class="library">
        <%= for series <- @results do %>
          <.live_component
            module={LLWeb.SeriesComponent}
            id={LLWeb.SeriesComponent.id(series.id)}
            series={series}
            href={~p"/series/#{series.id}"}
            select={true}
          />
        <% end %>
        <%= if @has_next do %>
          <button phx-click="next_page">More</button>
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

  def render_filter(form, filter, id_acc \\ nil) do
    filter_id = if id_acc, do: id_acc ++ [filter.name], else: [filter.name]

    assigns = %{
      form: form,
      filter: filter,
      filter_id: filter_id,
      name: filter.name,
      field: form[key(filter_id)]
    }

    case filter.type do
      "group" ->
        ~H"""
        <div class="group">
          <span>{@name}</span>
          <div class="items">
            <%= for f <- @filter.group do %>
              {render_filter(@form, f, @filter_id)}
            <% end %>
          </div>
        </div>
        """

      "check" ->
        ~H"""
        <div class="check">
          <input
            type="checkbox"
            name={@field.name}
            id={@field.id}
            checked={@field.value || false}
          />
          <label for={@field.id}>{@name}</label>
        </div>
        """

      "sort" ->
        ~H"""
        <div>
          <span>{@name}</span>
          <select name={@field.name} id={@field.id}>
            <%= for {v, i} <- Enum.with_index(@filter.values) do %>
              <option value={i} selected={to_string(i) == to_string(@field.value)}>{v}</option>
            <% end %>
          </select>
          <span class="check">
            <% ascending_id = key(@filter_id ++ ["ascending"]) %>
            <input
              type="checkbox"
              class="ascending"
              name={@form[ascending_id].name}
              id={@form[ascending_id].id}
              checked={@form[ascending_id].value}
            />
            <label for={@form[ascending_id].id}>Ascending</label>
          </span>
        </div>
        """

      "select" ->
        ~H"""
        <div>
          <span>{@name}</span>
          <select name={@field.name} id={@field.id}>
            <%= for {v, i} <- Enum.with_index(@filter.values) do %>
              <option value={i} selected={to_string(i) == to_string(@field.value)}>{v}</option>
            <% end %>
          </select>
        </div>
        """

      "triState" ->
        if id_acc do
          ~H"""
          <span class="tristate">
            <input
              type="number"
              min="0"
              max="2"
              phx-hook="tristate"
              name={@field.name}
              id={@field.id}
              value={@field.value || 0}
            />
            <label for={@field.id} state={@field.value || 0}>{@name}</label>
          </span>
          """
        else
          ~H"""
          <div class="tristate">
            <input
              type="number"
              min="0"
              max="2"
              phx-hook="tristate"
              name={@field.id}
              id={@field.id}
              value={@field.value || 0}
            />
            <label for={@field.id} state={@field.value || 0}>{@name}</label>
          </div>
          """
        end

      "header" ->
        ~H"""
        <div><span>{@name}</span></div>
        """

      "separator" ->
        ~H"""
        <div class="separator"></div>
        """

      "text" ->
        ~H"""
        <div>
          <label for={@field.id}>{@name}</label>
          <input
            name={@field.name}
            type="text"
            id={@field.id}
            value={@field.value}
          />
        </div>
        """

      _ ->
        ~H"""
        {inspect(@filter)}
        """
    end
  end

  def get_option(filter, id_acc \\ nil) do
    filter_id = if id_acc, do: id_acc ++ [filter.name], else: [filter.name]

    case filter do
      %{type: "group", group: group} ->
        Enum.map(group, &get_option(&1, filter_id)) |> List.flatten()

      %{type: "check", state: state} ->
        [{filter_id, state}]

      %{type: "sort", state: state} ->
        [
          {filter_id, state.index},
          {filter_id ++ ["ascending"], state.ascending}
        ]

      %{type: "select", state: state} ->
        [{filter_id, state}]

      %{type: "triState", state: state} ->
        [{filter_id, state}]

      %{type: "text", state: state} ->
        [{filter_id, state}]

      _ ->
        []
    end
  end

  def get_options(filters) do
    filters |> Enum.map(&get_option(&1)) |> List.flatten()
  end

  def mount(%{"source" => id}, _session, socket) do
    source = Repo.get(Source, id) |> Repo.preload(:extension)

    filters =
      case LL.Source.get_filters(source) do
        [] ->
          pid = self()

          ExtensionManager.filters(source, fn filters ->
            send(pid, {:filters, filters})
          end)

          []

        filters ->
          filters
      end

    options = get_options(filters)

    form =
      options
      |> Enum.map(&{key(elem(&1, 0)), elem(&1, 1)})
      |> Map.new()
      |> Map.merge(%{"query" => ""})
      |> to_form()

    socket =
      socket
      |> assign(options: options)
      |> assign(source: source)
      |> assign(filters: filters)
      |> assign(search_id: 0)
      |> assign(page: 1)
      |> assign(query: "")
      |> assign(results: [])
      |> assign(has_next: false)
      |> assign(search_form: form)

    {:ok, socket}
  end

  def handle_info({:search_result, search_id, results, has_next}, socket)
      when socket.assigns.search_id == search_id do
    new_results =
      socket.assigns.results
      |> Kernel.++(results)
      |> Enum.uniq_by(& &1.id)

    socket =
      socket
      |> assign(results: new_results)
      |> assign(has_next: has_next)

    {:noreply, socket}
  end

  def handle_info({:search_result, _}, socket) do
    {:noreply, socket}
  end

  def handle_info({:filters, filters}, socket) do
    {:noreply, assign(socket, filters: filters)}
  end

  def key(id), do: Phoenix.HTML.javascript_escape(inspect(id))

  defp to_filters(options) do
    Enum.map(options, fn {key, val} ->
      value =
        case val do
          "on" -> true
          "off" -> false
          v -> v
        end

      [key, value]
    end)
  end

  def handle_event("next_page", _params, socket) do
    page = socket.assigns.page + 1

    source = socket.assigns.source
    query = socket.assigns.query
    filters = to_filters(socket.assigns.options)

    socket =
      socket
      |> assign(page: page)
      |> assign(search_id: Ecto.UUID.generate())

    pid = self()

    ExtensionManager.search(source, query, filters, page, fn results, has_next ->
      send(pid, {:search_result, socket.assigns.search_id, results, has_next})
    end)

    {:noreply, socket}
  end

  def handle_event("search", %{"query" => query} = params, socket) do
    source = socket.assigns.source

    options =
      socket.assigns.options
      |> Enum.map(&{elem(&1, 0), Map.get(params, key(elem(&1, 0)), elem(&1, 1))})

    new_form =
      options
      |> Enum.map(&{key(elem(&1, 0)), elem(&1, 1)})
      |> Map.new()
      |> Map.merge(%{"query" => query})
      |> to_form()

    filters = to_filters(options)

    page = 1

    socket =
      socket
      |> assign(options: options)
      |> assign(search_id: Ecto.UUID.generate())
      |> assign(query: query)
      |> assign(page: page)
      |> assign(search_form: new_form)
      |> assign(results: [])

    pid = self()

    ExtensionManager.search(source, query, filters, page, fn results, has_next ->
      send(pid, {:search_result, socket.assigns.search_id, results, has_next})
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
