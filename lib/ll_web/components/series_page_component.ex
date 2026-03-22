defmodule LLWeb.SeriesPageComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesPageComponent">
      <div class="navigation">
        <%= if assigns[:close] do %>
          <.link navigate={assigns[:close]} class="button" draggable="false">Close</.link>
        <% else %>
          <button phx-click="close_series">Close</button>
        <% end %>
      </div>
      <div class="body">
        <div class="head">
          <%= if @series.thumbnail_path != nil and File.exists?(@series.thumbnail_path) do %>
            <div class="cover-image">
              <img src={
                Routes.static_path(@socket, "/thumbnail/#{Path.basename(@series.thumbnail_path)}")
              } />
            </div>
          <% end %>
          <div class="info">
            <h1>{@series.title}</h1>
            <span>Author: <span class="author">{@series.author}</span></span>
            <span>Artist: <span class="artist">{@series.artist}</span></span>
            <span>Status: <span class="status">{@series.status}</span></span>
            <span>Source: <span class="source">{@source.name} ({@source.lang})</span></span>
            <span>
              Last details refresh:
              <span class="updated">{relative_time(@series.details_updated)}</span>
            </span>
            <span>
              Last chapter refresh:
              <span class="updated">{relative_time(@series.chapters_updated)}</span>
            </span>
          </div>
        </div>
        <div class="actions">
          <button phx-click="refresh">Refresh</button>
          <button phx-click="refresh_chapters">Refresh chapters</button>
          <%= if @series.in_library do %>
            <button phx-click="library_remove">Remove from library</button>
          <% else %>
            <button phx-click="library_add">Add to library</button>
          <% end %>
        </div>
        <div class="tags">[tags]</div>
        <div class="description">{@series.description}</div>
        <div class="chapterlist">
          <% sorted =
            Enum.sort_by(
              @chapters,
              fn c ->
                {c.number,
                 Regex.scan(~r/\d+\.?\d*/, c.title)
                 |> List.flatten()
                 |> Enum.map(&(Float.parse(&1) |> elem(0)))}
              end,
              :desc
            ) %>
          <%= for c <- sorted do %>
            <.live_component2 module={LLWeb.ChapterComponent} id={c.id} chapter={c} />
          <% end %>
        </div>
      </div>
    </div>
    """
  end

  def update(assigns, socket) do
    socket = assign(socket, assigns)

    socket =
      socket
      |> subscribe_once("series:#{socket.assigns.series.id}")
      |> subscribe_once("chapters:#{socket.assigns.series.id}")

    {:ok, socket}
  end

  defmacro __using__(opts) do
    quote do
      def handle_event("refresh", _, socket) do
        LL.ExtensionManager.series_details(socket.assigns.series)
        {:noreply, socket}
      end

      def handle_event("refresh_chapters", _, socket) do
        LL.ExtensionManager.series_chapters(socket.assigns.series)
        {:noreply, socket}
      end

      def handle_event("library_add", _, socket) do
        {:ok, series} =
          LL.Repo.transact(fn ->
            LL.Repo.get(LL.Series, socket.assigns.series.id)
            |> Ecto.Changeset.change(%{in_library: true})
            |> LL.Repo.update()
          end)

        series =
          series
          |> LL.Repo.preload(source: :extension)
          |> LL.Repo.preload(:tags)

        LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

        LLWeb.LibraryLive.update()

        {:noreply, socket}
      end

      def handle_event("library_remove", _, socket) do
        {:ok, series} =
          LL.Repo.transact(fn ->
            LL.Repo.get(LL.Series, socket.assigns.series.id)
            |> Ecto.Changeset.change(%{in_library: false})
            |> LL.Repo.update()
          end)

        series =
          series
          |> LL.Repo.preload(source: :extension)
          |> LL.Repo.preload(:tags)

        LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

        LLWeb.LibraryLive.update()

        {:noreply, socket}
      end

      def handle_info(%{topic: "series:" <> id, event: "update", payload: series}, socket) do
        LLWeb.SeriesPageComponent.update_assigns(series.id, series: series)
        {:noreply, socket}
      end

      def handle_info(%{topic: "chapters:" <> id, event: "update", payload: chapters}, socket) do
        LLWeb.SeriesPageComponent.update_assigns(id, chapters: chapters)
        {:noreply, socket}
      end
    end
  end
end
