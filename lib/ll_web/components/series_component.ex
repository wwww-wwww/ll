defmodule LLWeb.SeriesComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class={"SeriesComponent #{if assigns[:is_multi], do: "multi"}"}>
      <%= if assigns[:select] do %>
        <.link id={@id} href={@href} phx-value-id={@series.id} phx-hook="select_series">
          <img
            :if={@series.thumbnail_path != nil and File.exists?(@series.thumbnail_path)}
            src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"}
          />
          <span class="title">{@series.title}</span>
        </.link>
      <% else %>
        <.link id={@id} patch={@href}>
          <% series = if assigns[:is_multi], do: @series.series, else: @series %>
          <img
            :if={series.thumbnail_path != nil and File.exists?(series.thumbnail_path)}
            src={~p"/thumbnail/#{Path.basename(series.thumbnail_path)}"}
          />
          <span class="title">{series.title}</span>
        </.link>
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

  defmacro __using__(_opts) do
    quote do
      def handle_info(%{topic: "series_thumb:" <> _, event: "update", payload: series}, socket) do
        LLWeb.SeriesComponent.update_assigns(series.id, series: series)
        {:noreply, socket}
      end
    end
  end
end
