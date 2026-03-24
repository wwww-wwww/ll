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
          <input
            type="text"
            id={@search_form[:query].id}
            name={@search_form[:query].name}
            value={@search_form[:query].value}
          />
          {submit("Search")}
        </div>
        <%= for filter <- @filters do %>
          {render_filter(assigns, filter)}
        <% end %>
        <div></div>
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

  def render_filter(assigns, %{name: name, type: type} = filter, id_acc \\ nil) do
    filter_id = "#{if id_acc, do: id_acc <> "_"}#{name}"

    case filter do
      %{type: "group", group: group} ->
        ~H"""
        <div>
          <span>{name}</span>
          <div>
            <%= for f <- group do %>
              {render_filter(assigns, f, filter_id)}
            <% end %>
          </div>
        </div>
        """

      %{type: "check", state: state} ->
        ~H"""
        <div>
          <input
            name={@search_form[filter_id].name}
            type="checkbox"
            id={@search_form[filter_id].id}
            checked={@search_form[filter_id].value}
          />
          <label for={@search_form[filter_id].id}>{name}</label>
        </div>
        """

      %{type: "sort", values: values, state: state} ->
        ~H"""
        <div>
          <span>{name}</span>
          <select name={@search_form[filter_id].name} id={@search_form[filter_id].id}>
            <%= for v <- values do %>
              <option value={v} selected={v == @search_form[filter_id].value}>{v}</option>
            <% end %>
          </select>
          <input
            name={@search_form["#{filter_id}_ascending"].name}
            id={@search_form["#{filter_id}_ascending"].id}
            type="checkbox"
            checked={@search_form["#{filter_id}_ascending"].value}
          />
        </div>
        """

      %{type: "select", values: values, state: state} ->
        ~H"""
        <div>
          <span>{name}</span>
          <select name={@search_form[filter_id].name} id={@search_form[filter_id].id}>
            <%= for v <- values do %>
              <option value={v} selected={v == @search_form[filter_id].value}>{v}</option>
            <% end %>
          </select>
        </div>
        """

      %{type: "triState", state: state} ->
        if id_acc do
          ~H"""
          <span>
            <input name={@search_form[filter_id].name} type="checkbox" id={@search_form[filter_id].id} />
            <label for={@search_form[filter_id].id}>{name}</label>
          </span>
          """
        else
          ~H"""
          <div>
            <input name={@search_form[filter_id].id} type="checkbox" id={@search_form[filter_id].id} />
            <label for={@search_form[filter_id].id}>{name}</label>
          </div>
          """
        end

      %{type: "header"} ->
        ~H"""
        <div><span>{name}</span></div>
        """

      %{type: "separator"} ->
        ~H"""
        <div class="separator"></div>
        """

      _ ->
        ~H"""
        {inspect(filter)}
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

  def handle_info({:filters, filters}, socket) do
    {:noreply, assign(socket, filters: filters)}
  end

  def handle_event("search", %{"query" => query} = params, socket) do
    search_id = Ecto.UUID.generate()

    search = %{
      id: search_id,
      query: query,
      page: 1,
      results: %{}
    }

    new_form =
      socket.assigns.search_form.source
      |> Enum.map(&{elem(&1, 0), Map.get(params, elem(&1, 0)) || false})
      |> Map.new()
      |> to_form()

    socket =
      socket
      |> assign(search: search)
      |> assign(search_form: new_form)

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
