defmodule LLWeb.SeriesComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesComponent">
      <%= if assigns[:click] do %>
        <.link navigate={assigns[:click]}>
          <%= if @series.thumbnail_path != nil and File.exists?(@series.thumbnail_path) do %>
            <img src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"} />
          <% else %>
            <img />
          <% end %>
          <span>{@series.title}</span>
        </.link>
      <% else %>
        <button phx-click="select_series" phx-value-id={@series.id} class="link">
          <%= if @series.thumbnail_path != nil and File.exists?(@series.thumbnail_path) do %>
            <img src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"} />
          <% else %>
            <img />
          <% end %>
          <span>{@series.title}</span>
        </button>
      <% end %>
    </div>
    """
  end

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("series_thumb:#{assigns.series.id}")
      |> assign(assigns)

    {:ok, socket}
  end

  defmacro __using__(opts) do
    quote do
      def handle_info(%{topic: "series_thumb:" <> _, event: "update", payload: series}, socket) do
        LLWeb.SeriesComponent.update_assigns(series.id, series: series)
        {:noreply, socket}
      end
    end
  end
end
