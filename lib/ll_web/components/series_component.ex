defmodule LLWeb.SeriesComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesComponent">
      <.link navigate={~p"/library/#{@series.id}"}>
        <%= if @series.thumbnail_path != nil and File.exists?(@series.thumbnail_path) do %>
          <img src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"} />
        <% else %>
          <img />
        <% end %>
        <span>{@series.title}</span>
      </.link>
    </div>
    """
  end

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("series:#{assigns.series.id}")
      |> assign(assigns)

    {:ok, socket}
  end

  defmacro __using__(opts) do
    quote do
      def handle_info(%{topic: "series:" <> _, event: "update", payload: series}, socket) do
        LLWeb.SeriesComponent.update_assigns(series.id, series: series)
        {:noreply, socket}
      end
    end
  end
end
