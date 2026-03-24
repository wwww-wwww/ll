defmodule LLWeb.ChapterComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class={["ChapterComponent", assigns[:selected] && "selected"]}>
      <% downloaded = @chapter.files != nil && Enum.filter(@chapter.files, &File.exists?/1) %>
      <%= if @chapter.files != nil do %>
        <%= if length(downloaded) != length(@chapter.files) do %>
          <div>
            <span>{length(downloaded)}/{length(@chapter.files)}</span>
          </div>
          <div>
            <button phx-click="download_chapter" value={@chapter.id}>Download</button>
          </div>
        <% end %>
      <% else %>
        <div>
          <button phx-click="download_chapter" value={@chapter.id}>Download</button>
        </div>
      <% end %>

      <%= if downloaded do %>
      <.link navigate={~p"/series/#{@chapter.series_id}/#{@chapter.id}"}>
        <div>
          <div>
            <span class="title">{@chapter.title}</span>
          </div>
          <div>
            <span class="date">{relative_time(@chapter.date)}</span>
            <span class="scanlator">{@chapter.scanlator}</span>
          </div>
        </div>
      </.link>
      <% else %>
      <div navigate={~p"/series/#{@chapter.series_id}/#{@chapter.id}"}>
        <div>
          <div>
            <span class="title">{@chapter.title}</span>
          </div>
          <div>
            <span class="date">{relative_time(@chapter.date)}</span>
            <span class="scanlator">{@chapter.scanlator}</span>
          </div>
        </div>
      </div>
      <% end %>
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
        LL.ExtensionManager.chapter_pages(chapter, chapter.source)

        {:noreply, socket}
      end

      def handle_info(%{topic: "chapter:" <> _, event: "update", payload: chapter}, socket) do
        LLWeb.ChapterComponent.update_assigns(chapter.id, chapter: chapter)
        {:noreply, socket}
      end
    end
  end
end
