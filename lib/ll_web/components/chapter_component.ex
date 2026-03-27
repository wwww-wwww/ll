defmodule LLWeb.ChapterComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class={["ChapterComponent", assigns[:selected] && "selected"]}>
      <% downloaded = @chapter.files != nil && Enum.filter(@chapter.files, &File.exists?/1) %>
      <%= if @chapter.files != nil do %>
        <%= if length(downloaded) != length(@chapter.files) do %>
          <div class="extra">
            <span>{length(downloaded)}/{length(@chapter.files)}</span>
            <button phx-click="download_chapter" value={@chapter.id} class="material-symbols-rounded">
              download
            </button>
          </div>
        <% end %>
      <% else %>
        <div class="extra">
          <button phx-click="download_chapter" value={@chapter.id} class="material-symbols-rounded">
            download
          </button>
        </div>
      <% end %>
      <div class="body">
        <%= if downloaded do %>
          <.link navigate={~p"/series/#{@chapter.series_id}/#{@chapter.id}"}>
            <div>
              <span class="number">{@chapter.number}</span>
              <span class="title">{@chapter.title}</span>
            </div>
            <div>
              <span class="date">{relative_time(@chapter.date)}</span>
              <%= if assigns[:show_source] do %>
                <span class="source">{@source.name}</span>
              <% end %>
              <span class="scanlator">{@chapter.scanlator}</span>
            </div>
          </.link>
        <% else %>
          <div>
            <div>
              <span class="number">{@chapter.number}</span>
              <span class="title">{@chapter.title}</span>
            </div>
            <div>
              <span class="date">{relative_time(@chapter.date)}</span>
              <%= if assigns[:show_source] do %>
                <span class="source">{@source.name}</span>
              <% end %>
              <span class="scanlator">{@chapter.scanlator}</span>
            </div>
          </div>
        <% end %>
      </div>

      <div class="extra">
        <.link
          class="button material-symbols-rounded"
          target="_blank"
          href={Path.join(@source.base_url, @chapter.url)}
        >
          globe
        </.link>
      </div>
    </div>
    """
  end

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("chapter:#{assigns.chapter.id}")
      |> assign(assigns)

    {:ok, socket}
  end

  defmacro __using__(_opts) do
    quote do
      def handle_event("download_chapter", %{"value" => chapter_id}, socket) do
        chapter = LL.Repo.get(LL.Chapter, chapter_id) |> LL.Repo.preload(source: :extension)
        LL.ExtensionManager.download_chapter(chapter, chapter.source)

        {:noreply, socket}
      end

      def handle_info(%{topic: "chapter:" <> _, event: "update", payload: chapter}, socket) do
        LLWeb.ChapterComponent.update_assigns(chapter.id, chapter: chapter)
        {:noreply, socket}
      end
    end
  end
end
