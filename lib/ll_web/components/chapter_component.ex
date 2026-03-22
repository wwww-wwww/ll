defmodule LLWeb.ChapterComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="ChapterComponent">
      <div>
        <%= if @chapter.files != nil do %>
          <% downloaded = Enum.filter(@chapter.files, &File.exists?/1) %>
          <%= if length(downloaded) != length(@chapter.files) do %>
            <span>{length(downloaded)}/{length(@chapter.files)}</span>
            <button phx-click="download_chapter" value={@chapter.id}>Download</button>
          <% end %>
        <% else %>
          <button phx-click="download_chapter" value={@chapter.id}>Download</button>
        <% end %>
      </div>
      <div>
        <div>
          <span class="number">{if @chapter.number > 0, do: @chapter.number, else: ""}</span>
          <span class="title">{@chapter.title}</span>
        </div>
        <div>
          <span class="date">{relative_time(@chapter.date)}</span>
          <span class="scanlator">{@chapter.scanlator}</span>
        </div>
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
      def handle_info(%{topic: "chapter:" <> _, event: "update", payload: chapter}, socket) do
        LLWeb.ChapterComponent.update_assigns(chapter.id, chapter: chapter)
        {:noreply, socket}
      end
    end
  end
end
