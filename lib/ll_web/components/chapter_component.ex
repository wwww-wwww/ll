defmodule LLWeb.ChapterComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="ChapterComponent">
      <%= if @state.files != nil do %>
        <% downloaded = Enum.filter(@state.files, &File.exists?/1) %>
        <%= if length(downloaded) != length(@state.files) do %>
          <span>{length(downloaded)}/{length(@state.files)}</span>
          <button phx-click="download_chapter" value={@state.id}>Download</button>
        <% end %>
      <% else %>
        <button phx-click="download_chapter" value={@state.id}>Download</button>
      <% end %>
      <span>{if @state.number > 0, do: @state.number, else: ""}</span>
      <span>{@state.title}</span>
      <span>{@state.date}</span>
      <span>{@state.scanlator}</span>
    </div>
    """
  end

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("chapter:#{assigns.state.id}")
      |> assign(assigns)

    {:ok, socket}
  end

  defmacro __using__(_opts) do
    quote do
      def handle_info(%{topic: "chapter:" <> _, event: "update", payload: state}, socket) do
        LLWeb.ChapterComponent.send_update(state)
        {:noreply, socket}
      end
    end
  end
end
