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

  def render_filter(form, filter, id_acc \\ nil) do
    filter_id = "#{if id_acc, do: id_acc <> "_"}#{filter.name}"

    assigns = %{
      form: form,
      filter: filter,
      filter_id: filter_id,
      name: filter.name,
      field: form[filter_id]
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
            name={@field.name}
            type="checkbox"
            id={@field.id}
            checked={@field.value}
          />
          <label for={@field.id}>{@name}</label>
        </div>
        """

      "sort" ->
        ~H"""
        <div>
          <span>{@name}</span>
          <select name={@field.name} id={@field.id}>
            <%= for v <- @filter.values do %>
              <option value={v} selected={v == @field.value}>{v}</option>
            <% end %>
          </select>
          <span class="check">
            <input
              class="ascending"
              name={@form["#{@filter_id}_ascending"].name}
              id={@form["#{@filter_id}_ascending"].id}
              type="checkbox"
              checked={@form["#{@filter_id}_ascending"].value}
            />
            <label for={@form["#{@filter_id}_ascending"].id}>Ascending</label>
          </span>
        </div>
        """

      "select" ->
        ~H"""
        <div>
          <span>{@name}</span>
          <select name={@field.name} id={@field.id}>
            <%= for v <- @filter.values do %>
              <option value={v} selected={v == @field.value}>{v}</option>
            <% end %>
          </select>
        </div>
        """

      "triState" ->
        if id_acc do
          ~H"""
          <span>
            <input
              phx-hook="tristate"
              class="tristate"
              name={@field.name}
              id={@field.id}
              value={@field.value}
              type="number"
            />
            <label class="tristate" for={@field.id}>{@name}</label>
          </span>
          """
        else
          ~H"""
          <div>
            <input
              phx-hook="tristate"
              class="tristate"
              name={@field.id}
              id={@field.id}
              value={@field.value}
              type="number"
            />
            <label class="tristate" for={@field.id}>{@name}</label>
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

  def get_option(filter, id_acc \\ nil, groups \\ []) do
    filter_id = "#{if id_acc, do: id_acc <> "_"}#{filter.name}"

    case filter do
      %{type: "group", group: group} ->
        Enum.map(group, &get_option(&1, filter_id, groups ++ [filter.name])) |> List.flatten()

      %{type: "check", state: state} ->
        [{filter_id, groups, state}]

      %{type: "sort", values: values, state: state} ->
        [
          {filter_id, groups, Enum.at(values, state.index)},
          {filter_id <> "_ascending", groups, state.ascending}
        ]

      %{type: "select", values: values, state: state} ->
        [{filter_id, groups, Enum.at(values, state)}]

      %{type: "triState", state: state} ->
        [{filter_id, groups, state}]

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
      |> Enum.map(&{elem(&1, 0), elem(&1, 2)})
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
      |> assign(search_form: form)

    {:ok, socket}
  end

  def handle_info({:search_result, search_id, results}, socket)
      when socket.assigns.search_id == search_id do
    {:noreply, assign(socket, results: results)}
  end

  def handle_info({:search_result, _}, socket) do
    {:noreply, socket}
  end

  def handle_info({:filters, filters}, socket) do
    {:noreply, assign(socket, filters: filters)}
  end

  def handle_event("search", %{"query" => query} = params, socket) do
    search_id = Ecto.UUID.generate()

    new_form =
      socket.assigns.search_form.source
      |> Enum.map(&{elem(&1, 0), Map.get(params, elem(&1, 0)) || false})
      |> Map.new()
      |> to_form()

    filters =
      socket.assigns.options
      |> Enum.map(fn {key, tree, default} ->
        value =
          case Map.get(params, key) do
            nil -> default
            "on" -> true
            "off" -> false
            val -> val
          end

        {key, tree, value}
      end)

    page = 1

    socket =
      socket
      |> assign(search_id: search_id)
      |> assign(query: query)
      |> assign(page: page)
      |> assign(search_form: new_form)

    pid = self()

    ExtensionManager.search(socket.assigns.source, query, filters, page, fn results ->
      send(pid, {:search_result, search_id, results})
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
