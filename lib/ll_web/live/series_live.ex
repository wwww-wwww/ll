defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  import Ecto.Query

  require Logger

  alias LL.{
    Repo,
    Series,
    Chapter,
    ExtensionManager,
    Library,
    LibraryMulti,
    LibrarySeries,
    MultiSeries,
    Message
  }

  def title(), do: "Series"

  def render(assigns) do
    ~H"""
    <div class="inner">
      <div class="head" phx-value-sid={@series.id}>
        <div
          :if={@series.thumbnail_path != nil and File.exists?(@series.thumbnail_path)}
          class="cover-image"
        >
          <img src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"} />
        </div>

        <div class="info">
          <h1>
            <.link :if={@is_multi} navigate={~p"/multi/#{@multi.id}"}>{@series.title} (Multi)</.link>
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
                    <.link :if={not @is_multi} href={Path.join(@series.source.base_url, @series.url)}>
                      {@series.source.name} ({@series.source.lang})
                    </.link>
                  </span>
                </span>
                <span>
                  Last details refresh:
                  <span class="updated">{relative_time(@series.details_updated)}</span>
                  <button :if={@current_scope.user} phx-click="refresh_details">Refresh</button>
                </span>

                <span :if={not @is_multi}>
                  Last chapter refresh:
                  <span class="updated">{relative_time(@series.chapters_updated)}</span>
                </span>
              </div>

              <div class="multis">
                <div>
                  Multi: <button :if={@is_multi} phx-click="multi_delete">Delete multi</button>
                  <%= if not @is_multi and @series.multi_series_id == nil and assigns[:multi] == nil do %>
                    <button :if={@current_scope.user} phx-click="multi_create">Create multi</button>
                    <button :if={@current_scope.user} phx-click="multi_get">Add to multi</button>
                  <% end %>

                  <%= if not @is_multi do %>
                    <.link :if={@multi} navigate={~p"/multi/#{@multi.id}"}>{@series.title}</.link>
                    <.link :if={@series.multi_series} navigate={~p"/multi/#{@series.multi_series.id}"}>
                      {@series.multi_series.series.title}
                    </.link>
                  <% end %>
                </div>

                <div :if={@is_multi}>
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
                </div>

                <div :if={assigns[:multis]}>
                  <span :for={m <- @multis |> Enum.filter(&(@series.multi_series_id != &1.id))}>
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
              <div
                :if={@current_scope.user}
                class="libraries"
              >
                <span>Libraries:</span>
                <div>
                  <span :for={l <- @libraries}>
                    <span>{l.name}</span>
                    <button
                      :if={in_library?(l, if(@is_multi, do: @multi, else: @series))}
                      phx-click="library-remove"
                      phx-value-id={l.id}
                      class="material-symbols-rounded"
                    >
                      close
                    </button>
                    <button
                      :if={!in_library?(l, if(@is_multi, do: @multi, else: @series))}
                      phx-click="library-add"
                      phx-value-id={l.id}
                      class="material-symbols-rounded"
                    >
                      add
                    </button>
                  </span>
                </div>
              </div>

              <div
                :if={@current_scope.user}
                class="libraries"
              >
                <span>Main libraries:</span>
                <div>
                  <span :for={l <- @main_libraries}>
                    <span>{l.name}</span>
                    <button
                      :if={in_library?(l, if(@is_multi, do: @multi, else: @series))}
                      phx-click="library-remove"
                      phx-value-id={l.id}
                      class="material-symbols-rounded"
                    >
                      close
                    </button>
                    <button
                      :if={!in_library?(l, if(@is_multi, do: @multi, else: @series))}
                      phx-click="library-add"
                      phx-value-id={l.id}
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
      <div :if={@current_scope.user} class="actions">
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
            href={~p"/multi/#{@multi.id}/#{c.id}"}
            chapter={c}
            source={s.source}
            show_source={true}
            show_hide={@show_hidden}
            user={@current_scope.user}
          />
        <% else %>
          <.live_component
            :for={c <- @chapters}
            :if={@show_hidden or c.hidden != true}
            module={LLWeb.ChapterComponent}
            id={LLWeb.ChapterComponent.id(c.id)}
            href={~p"/series/#{c.series_id}/#{c.id}"}
            chapter={c}
            source={@series.source}
            show_hide={@show_hidden}
            user={@current_scope.user}
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

  def in_library?(library, %MultiSeries{} = multi),
    do: Enum.any?(library.multi_series, &(&1.id == multi.id))

  def in_library?(library, %Series{} = series),
    do: Enum.any?(library.series, &(&1.id == series.id))

  def mount(:not_mounted_at_router, session, socket) do
    socket = LLWeb.UserAuth.mount_current_scope(socket, session)
    mount(session, nil, socket)
  end

  def mount(%{"multi_id" => multi_id}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("multi:#{multi_id}")
    end

    multi =
      Repo.get(MultiSeries, multi_id)
      |> Repo.preload(series: [:source, :chapters], children: [:source, :chapters])

    chapters = MultiSeries.get_chapters(multi)

    socket =
      if socket.assigns.current_scope.user do
        assign(socket, libraries: get_libraries(socket))
      else
        socket
      end

    socket =
      socket
      |> assign(multi: multi)
      |> assign(is_multi: true)
      |> assign(page_title: multi.series.title)
      |> assign(series: multi.series)
      |> assign(chapters: chapters)
      |> assign(show_hidden: false)
      |> assign(main_libraries: LLWeb.MainLibraryLive.main_libraries())

    {:ok, socket}
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("series:#{series_id}")
      Endpoint.subscribe("chapters:#{series_id}")
    end

    series =
      Repo.get(Series, series_id)
      |> Repo.preload(source: :extension, multi_series: :series)

    multi = Repo.get_by(MultiSeries, series_id: series.id)

    chapters = Chapter.list(series)

    socket =
      if socket.assigns.current_scope.user do
        assign(socket, libraries: get_libraries(socket))
      else
        socket
      end

    socket =
      socket
      |> assign(multi: multi)
      |> assign(is_multi: false)
      |> assign(page_title: series.title)
      |> assign(series: series)
      |> assign(chapters: chapters)
      |> assign(show_hidden: false)
      |> assign(main_libraries: LLWeb.MainLibraryLive.main_libraries())

    if series.details_updated == nil do
      ExtensionManager.series_details(series)
    end

    if series.chapters_updated == nil do
      ExtensionManager.series_chapters(series)
    end

    {:ok, socket}
  end

  def update(%LL.Series{} = series) do
    series = LL.Repo.preload(series, multi_series: :series)

    Endpoint.broadcast("series:#{series.id}", "update", series)

    if multi = Repo.get_by(MultiSeries, series_id: series.id) do
      update(multi)
    end
  end

  def update(%LL.MultiSeries{} = multi) do
    multi =
      LL.Repo.preload(multi, series: [:source, :chapters], children: [:source, :chapters])

    chapters = MultiSeries.get_chapters(multi)

    Endpoint.broadcast("multi:#{multi.id}", "update", {multi, chapters})
  end

  def get_libraries(socket) do
    user = socket.assigns.current_scope.user

    from(l in Library, where: l.user_id == ^user.id)
    |> Repo.all()
    |> Repo.preload([:multi_series, :series])
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
        |> Ecto.Changeset.change(%{multi_series_id: multi.id})
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
      |> Ecto.Changeset.change(%{multi_series_id: multi.id})
      |> Repo.update!()

      {:ok, series} =
        Repo.get(Series, id)
        |> Ecto.Changeset.change(%{multi_series_id: nil})
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
        |> Ecto.Changeset.change(%{multi_series_id: nil})
        |> Repo.update!()

      multi = Repo.reload(socket.assigns[:multi]) || Repo.get(MultiSeries, series.multi_series_id)

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

  def handle_event("library-add", %{"id" => id}, socket) do
    library = Repo.get_by(Library, id: id)

    Repo.transact(fn ->
      if socket.assigns.is_multi do
        %LibraryMulti{library_id: library.id, multi_series_id: socket.assigns.multi.id}
      else
        %LibrarySeries{library_id: library.id, series_id: socket.assigns.series.id}
      end
      |> Repo.insert()
    end)
    |> case do
      {:ok, _} ->
        {:noreply,
         assign(socket, libraries: get_libraries(socket))
         |> assign(main_libraries: LLWeb.MainLibraryLive.main_libraries())}

      err ->
        Message.error(err)
        {:noreply, socket}
    end
  end

  def handle_event("library-remove", %{"id" => id}, socket) do
    Repo.transact(fn ->
      if socket.assigns.is_multi do
        Repo.get_by(LibraryMulti,
          library_id: id,
          multi_series_id: socket.assigns.multi.id
        )
        |> Repo.delete()
      else
        Repo.get_by(LibrarySeries,
          library_id: id,
          series_id: socket.assigns.series.id
        )
        |> Repo.delete()
      end
    end)
    |> case do
      {:ok, _} ->
        {:noreply,
         assign(socket, libraries: get_libraries(socket))
         |> assign(main_libraries: LLWeb.MainLibraryLive.main_libraries())}

      err ->
        Message.error(err)
        {:noreply, socket}
    end
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
