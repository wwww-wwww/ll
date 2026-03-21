defmodule LLWeb.ChapterComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="ChapterComponent" id={"ChapterComponent_#{@chapter.id}"}>
        <%= if @chapter.files != nil and @chapter.files |> Enum.all?(&File.exists?(&1)) do %>
            <span></span>
        <% else %>
            <button phx-click="download_chapter" value={@chapter.id}>Download</button>
        <% end %>
        <span>{@chapter.title}</span>
        <span>{@chapter.date}</span>
        <span>{@chapter.scanlator}</span>
    </div>
    """
  end

  def update(assigns, socket) do
    if connected?(socket) do
      Endpoint.subscribe("chapter:#{assigns.chapter.id}")
    end

    socket = assign(socket, assigns)

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
