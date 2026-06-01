defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  import Ecto.Query

  require Logger
  require LL.Downloader

  alias LL.{
    Downloader,
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
      <div class="head" phx-value-sid={@entry.id}>
        <div
          :if={@entry.thumbnail_path != nil and File.exists?(@entry.thumbnail_path)}
          class="cover-image"
        >
          <img src={~p"/thumbnail/#{Path.basename(@entry.thumbnail_path)}"} />
        </div>

        <div class="info">
          <h1>
            <.link :if={@is_multi} navigate={~p"/multi/#{@entry.id}"}>{@entry.title} (Multi)</.link>
            <.link :if={not @is_multi} navigate={~p"/series/#{@entry.id}"}>{@entry.title}</.link>
          </h1>
          <div>
            <div>
              <div>
                <span>
                  Anilist:
                  <.link class="anilist" href={"https://anilist.co/manga/#{@entry.anilist_id}"}>
                    {@entry.anilist_id}
                  </.link>
                </span>
                <span>Author: <span class="author">{@entry.author}</span></span>
                <span>Artist: <span class="artist">{@entry.artist}</span></span>
                <span>Status: <span class="status">{status(@entry)}</span></span>
                <span>
                  Source:
                  <span class="source">
                    <span :if={@is_multi}>Multi</span>
                    <.link :if={not @is_multi} href={Path.join(@entry.source.base_url, @entry.url)}>
                      {@entry.source.name} ({@entry.source.lang})
                    </.link>
                  </span>
                </span>

                <span :if={not @is_multi}>
                  Last chapter refresh:
                  <span class="updated">{relative_time(@entry.chapters_updated)}</span>
                </span>
              </div>

              <div :if={LL.User.mod?(@current_scope)} class="anilist-details">
                Anilist
                <form phx-submit="anilist-search">
                  <div>
                    <input type="text" name="title" value={@entry.title || @entry.series.title} />
                    <input type="submit" value="Search" />
                  </div>
                </form>

                <div>
                  <span :for={{t, i} <- (assigns[:anilist_search_results] || []) |> Enum.with_index()}>
                    <% title = t["title"]["english"] || t["title"]["romaji"] || t["title"]["native"] %>
                    <img src={t["coverImage"]["extraLarge"]} />
                    <.link href={t["siteUrl"]} target="_blank">{title}</.link>
                    <div
                      :for={title <- Enum.map(t["title"], &elem(&1, 1)) ++ t["synonyms"]}
                      :if={!is_nil(title)}
                    >
                      {title}
                      <button
                        phx-click="anilist-details-set"
                        phx-value-details={i}
                        phx-value-title={title}
                      >
                        Set
                      </button>
                    </div>
                  </span>
                </div>
              </div>

              <div
                :if={@is_multi or not is_nil(@entry.multi_series) or LL.User.mod?(@current_scope)}
                class="multis"
              >
                <div>
                  Multi:
                  <button :if={@is_multi and LL.User.mod?(@current_scope)} phx-click="multi_delete">
                    Delete multi
                  </button>
                  <%= if LL.User.mod?(@current_scope) and not @is_multi and @entry.multi_series_id == nil and assigns[:multi] == nil do %>
                    <button phx-click="multi_create">Create multi</button>
                    <button phx-click="multi_get">Add to multi</button>
                  <% end %>

                  <%= if not @is_multi do %>
                    <.link :if={@entry.multi_series} navigate={~p"/multi/#{@entry.multi_series.id}"}>
                      {@entry.multi_series.title || @entry.multi_series.series.title}
                    </.link>
                  <% end %>
                </div>

                <div :if={@is_multi}>
                  <span :for={s <- Enum.sort_by(@multi_children, &(&1.priority || 0))}>
                    <%= if LL.User.mod?(@current_scope) do %>
                      <span>{inspect(s.priority)}</span>
                      <button
                        phx-click="multi-priority-up"
                        phx-value-id={s.id}
                        class="material-symbols-rounded"
                      >
                        keyboard_arrow_up
                      </button>
                    <% end %>
                    <.link navigate={~p"/series/#{s.id}"}>{s.source.name}</.link>
                    <span class="updated">{relative_time(s.chapters_updated)}</span>
                    <button
                      :if={LL.User.mod?(@current_scope) and @multi.series.id != s.id}
                      phx-click="multi_set_primary"
                      phx-value-id={s.id}
                    >
                      Set primary
                    </button>
                    <button
                      :if={LL.User.mod?(@current_scope)}
                      phx-click="multi_remove"
                      phx-value-id={s.id}
                      class="material-symbols-rounded"
                    >
                      close
                    </button>
                  </span>
                </div>

                <div :if={assigns[:multis]}>
                  <span :for={m <- @multis |> Enum.filter(&(@entry.multi_series_id != &1.id))}>
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
                      :if={in_library?(l, @entry)}
                      phx-click="library-remove"
                      phx-value-id={l.id}
                      class="material-symbols-rounded"
                    >
                      close
                    </button>
                    <button
                      :if={!in_library?(l, @entry)}
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
                :if={LL.User.mod?(@current_scope.user)}
                class="libraries"
              >
                <span>Main libraries:</span>
                <div>
                  <span :for={l <- @main_libraries}>
                    <span>{l.name}</span>
                    <button
                      :if={in_library?(l, @entry)}
                      phx-click="library-remove"
                      phx-value-id={l.id}
                      class="material-symbols-rounded"
                    >
                      close
                    </button>
                    <button
                      :if={!in_library?(l, @entry)}
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

      <div class="tags">{@entry.genre}</div>
      <div class="description">{raw(HtmlSanitizeEx.basic_html(@entry.description))}</div>
      <div :if={LL.User.mod?(@current_scope)} class="actions">
        <button phx-click="refresh_chapters">Refresh chapters</button>
        <button phx-click="download_all">Download all</button>
        <button phx-click="editing" phx-value-show={if @editing, do: 0, else: 1}>
          <%= if @editing do %>
            Stop editing
          <% else %>
            Edit
          <% end %>
        </button>
      </div>
      <div class="chapterlist">
        <%= if @is_multi do %>
          <.live_component
            :for={{s, c} <- @chapters}
            :if={c.hidden != true or @editing}
            module={LLWeb.ChapterComponent}
            id={LLWeb.ChapterComponent.id(c.id)}
            href={~p"/multi/#{@multi.id}/#{c.id}"}
            chapter={c}
            source={s.source}
            show_source={true}
            show_edit={@editing}
            user={@current_scope.user}
          />
        <% else %>
          <.live_component
            :for={c <- @chapters}
            :if={c.hidden != true or @editing}
            module={LLWeb.ChapterComponent}
            id={LLWeb.ChapterComponent.id(c.id)}
            href={~p"/series/#{c.series_id}/#{c.id}"}
            chapter={c}
            source={@entry.source}
            show_edit={@editing}
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

    if not File.exists?(multi.thumbnail_path) do
      LL.Anilist.download_cover(multi)
    end

    chapters = MultiSeries.get_chapters(multi)

    socket =
      if socket.assigns.current_scope.user do
        assign(socket, libraries: get_libraries(socket))
      else
        socket
      end

    socket =
      socket
      |> assign(entry: multi)
      |> assign(multi: multi)
      |> assign(multi_children: multi.children)
      |> assign(is_multi: true)
      |> assign(page_title: multi.series.title)
      |> assign(chapters: chapters)
      |> assign(editing: false)
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

    if not File.exists?(series.thumbnail_path) do
      LL.Anilist.download_cover(series)
    end

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
      |> assign(entry: series)
      |> assign(multi: multi)
      |> assign(is_multi: false)
      |> assign(page_title: series.title)
      |> assign(chapters: chapters)
      |> assign(editing: false)
      |> assign(source: series.source)
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
    series = LL.Repo.preload(series, [[multi_series: :series], :source])

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
    ExtensionManager.series_details(socket.assigns.entry)
    {:noreply, socket}
  end

  def handle_event("refresh_chapters", _, socket) do
    ExtensionManager.series_chapters(socket.assigns.entry)

    if socket.assigns.is_multi do
      socket.assigns.entry.children |> Enum.each(&ExtensionManager.series_chapters/1)
    end

    {:noreply, socket}
  end

  def handle_event("download_all", _, socket) do
    Repo.get(Series, socket.assigns.entry.id)
    |> Repo.preload(:chapters)
    |> Map.get(:chapters)
    |> Enum.reject(&Chapter.downloaded?(&1))
    |> Enum.reverse()
    |> Enum.each(&ExtensionManager.download_chapter(&1, socket.assigns.source))

    {:noreply, socket}
  end

  def handle_event("multi_create", _, socket) do
    %MultiSeries{}
    |> Ecto.Changeset.change(%{series_id: socket.assigns.entry.id})
    |> Repo.insert()
    |> case do
      {:ok, multi} ->
        Endpoint.broadcast("series:#{socket.assigns.entry.id}", "multi", multi)

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
        socket.assigns.entry
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
        socket.assigns.entry
        |> Repo.reload()
        |> Repo.preload(:series)

      multi.series
      |> Ecto.Changeset.change(%{multi_series_id: multi.id})
      |> Repo.update!()

      series = Repo.get(Series, id)

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
      socket.assigns.entry
      |> Repo.delete()
      |> case do
        {:ok, _} ->
          socket.assigns.entry.children |> Enum.each(&update/1)
          update(socket.assigns.entry.series)
          Endpoint.broadcast("series:#{socket.assigns.entry.id}", "multi", nil)
          push_navigate(socket, to: ~p"/")

        err ->
          Message.error(err)
          socket
      end

    {:noreply, socket}
  end

  def handle_event("multi-priority-up", %{"id" => id}, socket) do
    Repo.transact(fn ->
      children =
        Repo.get(MultiSeries, socket.assigns.multi.id)
        |> Repo.preload(:children)
        |> Map.get(:children)
        |> Enum.sort_by(&(&1.priority || 0))

      idx = Enum.find_index(children, &(to_string(&1.id) == id))

      children
      |> List.replace_at(idx, Enum.at(children, idx - 1))
      |> List.replace_at(idx - 1, Enum.at(children, idx))
      |> Enum.with_index()
      |> Enum.map(fn {e, i} ->
        Ecto.Changeset.change(e, %{priority: i})
        |> Repo.update!()
      end)

      {:ok, nil}
    end)
    |> case do
      {:ok, _} ->
        multi_children =
          Repo.get(MultiSeries, socket.assigns.multi.id)
          |> Repo.preload(children: :source)
          |> Map.get(:children)

        {:noreply, assign(socket, multi_children: multi_children)}

      _ ->
        {:noreply, socket}
    end
  end

  def handle_event("library-add", %{"id" => id}, socket) do
    library = Repo.get_by(Library, id: id)

    Repo.transact(fn ->
      if socket.assigns.is_multi do
        %LibraryMulti{library_id: library.id, multi_series_id: socket.assigns.entry.id}
      else
        %LibrarySeries{library_id: library.id, series_id: socket.assigns.entry.id}
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
          multi_series_id: socket.assigns.entry.id
        )
        |> Repo.delete()
      else
        Repo.get_by(LibrarySeries,
          library_id: id,
          series_id: socket.assigns.entry.id
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

  def handle_event("editing", %{"show" => b}, socket) do
    {:noreply, assign(socket, editing: b == "1")}
  end

  def handle_event("anilist-search", %{"title" => title}, socket) do
    query = """
    query ($title: String) {
      Page {
        media (search: $title, type: MANGA) {
          siteUrl
          title {
            english
            romaji
            native
          }
          status
          staff {
            edges {
              role
              node {
                name {
                  full
                }
              }
            }
          }
          coverImage {
            extraLarge
          }
          id
          description
          synonyms
        }
      }
    }
    """

    body = Jason.encode!(%{query: query, variables: %{title: title}})

    HTTPoison.request(%HTTPoison.Request{
      method: "POST",
      url: "https://graphql.anilist.co",
      body: body,
      headers: [
        {"Accept", "application/json"},
        {"Content-Type", "application/json"}
      ],
      options: [recv_timeout: 30000]
    })
    |> case do
      {:ok, %{body: body}} ->
        results =
          Jason.decode!(body)
          |> Map.get("data")
          |> Map.get("Page")
          |> Map.get("media")

        {:noreply, socket |> assign(:anilist_search_results, results)}

      err ->
        IO.inspect(err)
        {:noreply, socket}
    end
  end

  def handle_event("anilist-details-set", %{"details" => details, "title" => title}, socket) do
    {index, _} = Integer.parse(details)

    details = socket.assigns.anilist_search_results |> Enum.at(index)

    author =
      details["staff"]["edges"]
      |> Enum.filter(&String.contains?(&1["role"], "Original Story"))
      |> Enum.map(& &1["node"]["name"]["full"])
      |> Enum.at(0) ||
        details["staff"]["edges"]
        |> Enum.filter(&String.contains?(&1["role"], "Story"))
        |> Enum.map(& &1["node"]["name"]["full"])
        |> Enum.at(0)

    artist =
      details["staff"]["edges"]
      |> Enum.filter(
        &(String.contains?(&1["role"], "Art") or String.contains?(&1["role"], "Illustration"))
      )
      |> Enum.map(& &1["node"]["name"]["full"])
      |> Enum.at(0)

    cover_url = details["coverImage"]["extraLarge"]

    {:ok, entry} =
      socket.assigns.entry
      |> Ecto.Changeset.change(%{
        anilist_id: details["id"],
        title: title |> String.trim(),
        thumbnail_path: cover_url,
        author: author,
        artist: artist,
        description: details["description"]
      })
      |> Repo.update()

    case entry do
      %MultiSeries{} -> Endpoint.broadcast("multi:#{entry.id}", "update", entry)
      %Series{} -> Endpoint.broadcast("series:#{entry.id}", "update", entry)
    end

    LL.Anilist.download_cover(cover_url, entry)

    {:noreply, assign(socket, entry: entry)}
  end

  def handle_info(%{topic: "series:" <> _id, event: "update", payload: series}, socket) do
    {:noreply, assign(socket, entry: series)}
  end

  def handle_info(%{topic: "series:" <> _id, event: "multi", payload: multi}, socket) do
    {:noreply, assign(socket, multi: multi)}
  end

  def handle_info(%{topic: "chapters:" <> _id, event: "update", payload: chapters}, socket) do
    {:noreply, assign(socket, chapters: chapters)}
  end

  def handle_info(%{topic: "multi:" <> _id, event: "update", payload: multi}, socket) do
    {:noreply, assign(socket, entry: multi)}
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
