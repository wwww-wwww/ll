defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  require Logger

  alias LL.{
    Repo,
    Series,
    Chapter,
    ExtensionManager,
    MultiSeries,
    Message,
    Category,
    SeriesCategory,
    MultiSeriesCategory
  }

  def title(), do: "Series"

  def render(assigns) do
    ~H"""
    <div class="inner">
      <div class="head" phx-value-sid={@series.id}>
        <%= if @series.thumbnail_path != nil and File.exists?(@series.thumbnail_path) do %>
          <div class="cover-image">
            <img src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"} />
          </div>
        <% end %>
        <div class="info">
          <h1>
            <.link :if={@is_multi} navigate={~p"/series/m#{@multi.id}"}>
              {@series.title} (Multi)
            </.link>
            <.link :if={not @is_multi} navigate={~p"/series/#{@series.id}"}>{@series.title}</.link>
          </h1>
          <div>
            <div>
              <div>
                <span>Author: <span class="author">{@series.author}</span></span>
                <span>Artist: <span class="artist">{@series.artist}</span></span>
                <span>Status: <span class="status">{status(@series)}</span></span>
                <span>
                  Source:
                  <span class="source">
                    <span :if={@is_multi}>Multi</span>
                    <.link :if={not @is_multi} href={Path.join(@source.base_url, @series.url)}>
                      {@source.name} ({@source.lang})
                    </.link>
                  </span>
                </span>
                <span>
                  Last details refresh:
                  <span class="updated">{relative_time(@series.details_updated)}</span>
                  <button phx-click="refresh_details">Refresh</button>
                </span>

                <span :if={not @is_multi}>
                  Last chapter refresh:
                  <span class="updated">{relative_time(@series.chapters_updated)}</span>
                </span>

                <span :if={not @is_multi}>
                  <button :if={@series.in_library} phx-click="library_remove">
                    Remove from library
                  </button>
                  <button :if={not @series.in_library} phx-click="library_add">Add to library</button>
                </span>
              </div>

              <div class="multis">
                <div>
                  Multi: <button :if={@is_multi} phx-click="multi_delete">Delete multi</button>
                  <%= if not @is_multi and @series.multiseries_id == nil and assigns[:multi] == nil do %>
                    <button phx-click="multi_create">Create multi</button>
                    <button phx-click="multi_get">Add to multi</button>
                  <% end %>

                  <%= if not @is_multi do %>
                    <%= if @multi != nil do %>
                      <.link navigate={~p"/series/m#{@multi.id}"}>{@series.title}</.link>
                    <% end %>
                    <%= if @series.multiseries != nil do %>
                      <.link navigate={~p"/series/m#{@series.multiseries.id}"}>
                        {@series.multiseries.series.title}
                      </.link>
                    <% end %>
                  <% end %>
                </div>

                <div>
                  <%= if @is_multi do %>
                    <span>
                      <.link navigate={~p"/series/#{@multi.series.id}"}>
                        {@multi.series.source.name}
                      </.link>
                      <span class="updated">{relative_time(@multi.series.chapters_updated)}</span>
                    </span>

                    <span :for={s <- @multi.children}>
                      <.link navigate={~p"/series/#{s.id}"}>{s.source.name}</.link>
                      <span class="updated">{relative_time(s.chapters_updated)}</span>
                      <button phx-click="multi_set_primary" phx-value-id={s.id}>Set primary</button>
                      <button
                        phx-click="multi_remove"
                        phx-value-id={s.id}
                        class="material-symbols-rounded"
                      >
                        close
                      </button>
                    </span>
                  <% end %>
                </div>

                <div :if={assigns[:multis]}>
                  <span :for={m <- @multis |> Enum.filter(&(@series.multiseries_id != &1.id))}>
                    <span>{m.series.title}</span>
                    <button
                      phx-click="multi_add"
                      phx-value-id={m.id}
                      class="material-symbols-rounded"
                    >
                      add
                    </button>
                  </span>
                </div>
              </div>
            </div>

            <div>
              <div class="categories">
                <span>Categories:</span>
                <div>
                  <% categories = if @is_multi, do: @multi.categories, else: @series.categories %>
                  <span :for={c <- categories}>
                    <span>{c.name}</span>
                    <button
                      phx-click="category_remove"
                      phx-value-id={c.id}
                      class="material-symbols-rounded"
                    >
                      close
                    </button>
                  </span>
                </div>

                <button phx-click="category_get">Add to category</button>
                <div :if={assigns[:categories]}>
                  <span :for={
                    c <-
                      @categories |> Enum.reject(fn c -> Enum.any?(categories, &(&1.id == c.id)) end)
                  }>
                    <span>{c.name}</span>
                    <button
                      phx-click="category_add"
                      phx-value-id={c.id}
                      class="material-symbols-rounded"
                    >
                      add
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="tags">{@series.genre}</div>
      <div class="description">{@series.description}</div>
      <div class="actions">
        <button phx-click="refresh_chapters">Refresh chapters</button>
        <button phx-click="download_all">Download all</button>
        <button phx-click="show_hidden" phx-value-show={if @show_hidden, do: 0, else: 1}>
          <%= if @show_hidden do %>
            Hide
          <% else %>
            Show
          <% end %>
          hidden ({@chapters
          |> Enum.filter(&if @is_multi, do: elem(&1, 1).hidden, else: &1.hidden)
          |> length})
        </button>
      </div>
      <div class="chapterlist">
        <%= if @is_multi do %>
          <.live_component
            :for={{s, c} <- @chapters}
            :if={@show_hidden or c.hidden != true}
            module={LLWeb.ChapterComponent}
            id={LLWeb.ChapterComponent.id(c.id)}
            chapter={c}
            source={s.source}
            show_source={true}
            show_hide={@show_hidden}
          />
        <% else %>
          <.live_component
            :for={c <- @chapters}
            :if={@show_hidden or c.hidden != true}
            module={LLWeb.ChapterComponent}
            id={LLWeb.ChapterComponent.id(c.id)}
            chapter={c}
            source={@source}
            show_hide={@show_hidden}
          />
        <% end %>
      </div>
    </div>
    """
  end

  @status %{
    0 => "Unknown",
    1 => "Ongoing",
    2 => "Completed",
    3 => "Licensed",
    4 => "Publishing finished",
    5 => "Canceled",
    6 => "On hiatus"
  }

  def status(series), do: @status[series.status]

  def mount(:not_mounted_at_router, params, socket) do
    mount(params, nil, socket)
  end

  def mount(%{"series_id" => multi_id, "is_multi" => true}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("multi:#{multi_id}")
    end

    multi =
      Repo.get(MultiSeries, multi_id)
      |> Repo.preload([
        [series: [:source, :chapters]],
        [children: [:source, :chapters]],
        :categories
      ])

    chapters = MultiSeries.get_chapters(multi)

    socket =
      socket
      |> assign(multi: multi)
      |> assign(is_multi: true)
      |> assign(page_title: multi.series.title)
      |> assign(series: multi.series)
      |> assign(chapters: chapters)
      |> assign(show_hidden: false)

    {:ok, socket}
  end

  def mount(%{"series_id" => "m" <> multi_id}, session, socket) do
    mount(%{"series_id" => multi_id, "is_multi" => true}, session, socket)
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("series:#{series_id}")
      Endpoint.subscribe("chapters:#{series_id}")
    end

    series =
      Repo.get(Series, series_id)
      |> Repo.preload([[source: :extension], [multiseries: :series], :categories])

    source = series.source

    chapters = Chapter.list(series)

    multi = Repo.get_by(MultiSeries, series_id: series.id)

    socket =
      socket
      |> assign(multi: multi)
      |> assign(is_multi: false)
      |> assign(page_title: series.title)
      |> assign(series: series)
      |> assign(source: source)
      |> assign(chapters: chapters)
      |> assign(show_hidden: false)

    if series.details_updated == nil do
      ExtensionManager.series_details(series)
    end

    if series.chapters_updated == nil do
      ExtensionManager.series_chapters(series)
    end

    {:ok, socket}
  end

  def update(%LL.Series{} = series) do
    series = LL.Repo.preload(series, [[multiseries: :series], :categories])

    Endpoint.broadcast("series:#{series.id}", "update", series)

    if multi = Repo.get_by(MultiSeries, series_id: series.id) do
      update(multi)
    end
  end

  def update(%LL.MultiSeries{} = multi) do
    multi =
      LL.Repo.preload(multi, [
        [series: [:source, :chapters]],
        [children: [:source, :chapters]],
        :categories
      ])

    chapters = MultiSeries.get_chapters(multi)

    Endpoint.broadcast("multi:#{multi.id}", "update", {multi, chapters})
  end

  def handle_event("refresh_details", _, socket) do
    ExtensionManager.series_details(socket.assigns.series)
    {:noreply, socket}
  end

  def handle_event("refresh_chapters", _, socket) do
    ExtensionManager.series_chapters(socket.assigns.series)

    if socket.assigns.is_multi do
      socket.assigns.multi.children |> Enum.each(&ExtensionManager.series_chapters/1)
    end

    {:noreply, socket}
  end

  def handle_event("library_add", _, socket) do
    Repo.transact(fn ->
      Repo.get(Series, socket.assigns.series.id)
      |> Ecto.Changeset.change(%{in_library: true})
      |> Repo.update()
    end)
    |> case do
      {:ok, series} ->
        LL.Message.create("Added {:library,#{series.id}} to library")
        update(series)
        LLWeb.LibraryLive.update()

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("library_remove", _, socket) do
    Repo.transact(fn ->
      Repo.get(Series, socket.assigns.series.id)
      |> Ecto.Changeset.change(%{in_library: false})
      |> Repo.update()
    end)
    |> case do
      {:ok, series} ->
        LL.Message.create("Removed {:library,#{series.id}} from library")
        update(series)
        LLWeb.LibraryLive.update()

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("download_all", _, socket) do
    Repo.get(Series, socket.assigns.series.id)
    |> Repo.preload(:chapters)
    |> Map.get(:chapters)
    |> Enum.reject(&Chapter.downloaded?(&1))
    |> Enum.reverse()
    |> Enum.each(&ExtensionManager.download_chapter(&1, socket.assigns.source))

    {:noreply, socket}
  end

  def handle_event("multi_create", _, socket) do
    %MultiSeries{}
    |> Ecto.Changeset.change(%{series_id: socket.assigns.series.id})
    |> Repo.insert()
    |> case do
      {:ok, multi} ->
        LLWeb.LibraryLive.update()
        Endpoint.broadcast("series:#{socket.assigns.series.id}", "multi", multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_get", _, socket) do
    multis = Repo.all(MultiSeries) |> Repo.preload(:series)
    {:noreply, assign(socket, multis: multis)}
  end

  def handle_event("multi_add", %{"id" => id}, socket) do
    Repo.transact(fn ->
      multi = Repo.get(MultiSeries, id)

      series =
        socket.assigns.series
        |> Repo.reload()
        |> Ecto.Changeset.change(%{multiseries_id: multi.id})
        |> Repo.update!()

      {:ok, {multi, series}}
    end)
    |> case do
      {:ok, {multi, series}} ->
        update(series)
        update(multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_set_primary", %{"id" => id}, socket) do
    Repo.transact(fn ->
      multi =
        socket.assigns.multi
        |> Repo.reload()
        |> Repo.preload(:series)

      multi.series
      |> Ecto.Changeset.change(%{multiseries_id: multi.id})
      |> Repo.update!()

      {:ok, series} =
        Repo.get(Series, id)
        |> Ecto.Changeset.change(%{multiseries_id: nil})
        |> Repo.update()

      multi
      |> Ecto.Changeset.change(%{series_id: series.id})
      |> Repo.update()
    end)
    |> case do
      {:ok, multi} ->
        update(multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_remove", %{"id" => id}, socket) do
    Repo.transact(fn ->
      series =
        Repo.get(Series, id)
        |> Ecto.Changeset.change(%{multiseries_id: nil})
        |> Repo.update!()

      multi = Repo.reload(socket.assigns[:multi]) || Repo.get(MultiSeries, series.multiseries_id)

      {:ok, {multi, series}}
    end)
    |> case do
      {:ok, {multi, series}} ->
        update(series)
        update(multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_delete", _, socket) do
    socket =
      socket.assigns.multi
      |> Repo.delete()
      |> case do
        {:ok, _} ->
          LLWeb.LibraryLive.update()
          socket.assigns.multi.children |> Enum.each(&update/1)
          update(socket.assigns.multi.series)
          Endpoint.broadcast("series:#{socket.assigns.series.id}", "multi", nil)
          push_navigate(socket, to: ~p"/")

        err ->
          Message.error(err)
          socket
      end

    {:noreply, socket}
  end

  def handle_event("category_get", _, socket) do
    categories = Repo.all(Category)
    {:noreply, assign(socket, categories: categories)}
  end

  def handle_event("category_add", %{"id" => id}, socket) do
    category = Repo.get(Category, id)

    Repo.transact(fn ->
      if socket.assigns.is_multi do
        %MultiSeriesCategory{}
        |> Ecto.Changeset.change(%{})
        |> Ecto.Changeset.put_assoc(:multiseries, socket.assigns.multi)
        |> Ecto.Changeset.put_assoc(:category, category)
        |> Repo.insert!()

        {:ok, Repo.reload(socket.assigns.multi)}
      else
        %SeriesCategory{}
        |> Ecto.Changeset.change(%{})
        |> Ecto.Changeset.put_assoc(:series, socket.assigns.series)
        |> Ecto.Changeset.put_assoc(:category, category)
        |> Repo.insert!()

        {:ok, Repo.reload(socket.assigns.series)}
      end
    end)
    |> case do
      {:ok, series} ->
        update(series)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("category_remove", %{"id" => id}, socket) do
    Repo.transact(fn ->
      if socket.assigns.is_multi do
        Repo.get_by(MultiSeriesCategory,
          multiseries_id: socket.assigns.multi.id,
          category_id: id
        )
        |> Repo.delete!()

        {:ok, Repo.reload(socket.assigns.multi)}
      else
        Repo.get_by(SeriesCategory, series_id: socket.assigns.series.id, category_id: id)
        |> Repo.delete!()

        {:ok, Repo.reload(socket.assigns.series)}
      end
    end)
    |> case do
      {:ok, series} ->
        update(series)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("show_hidden", %{"show" => b}, socket) do
    {:noreply, assign(socket, show_hidden: b == "1")}
  end

  def handle_info(%{topic: "series:" <> _id, event: "update", payload: series}, socket) do
    {:noreply, assign(socket, series: series)}
  end

  def handle_info(%{topic: "series:" <> _id, event: "multi", payload: multi}, socket) do
    {:noreply, assign(socket, multi: multi)}
  end

  def handle_info(%{topic: "chapters:" <> _id, event: "update", payload: chapters}, socket) do
    {:noreply, assign(socket, chapters: chapters)}
  end

  def handle_info(%{topic: "multi:" <> _id, event: "update", payload: {multi, chapters}}, socket) do
    socket =
      socket
      |> assign(multi: multi)
      |> assign(page_title: multi.series.title)
      |> assign(series: multi.series)
      |> assign(chapters: chapters)

    {:noreply, assign(socket, multi: multi)}
  end
end
