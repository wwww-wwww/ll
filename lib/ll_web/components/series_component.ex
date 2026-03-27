defmodule LLWeb.SeriesComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesComponent">
      <.link
        id={@id}
        href={@href}
        phx-value-id={if assigns[:multi_id], do: "m#{@multi_id}", else: @series.id}
        phx-hook="select_series"
      >
        <%= if @series.thumbnail_path != nil and File.exists?(@series.thumbnail_path) do %>
          <img src={
            Routes.static_path(@socket, "/thumbnail/#{Path.basename(@series.thumbnail_path)}")
          } />
        <% else %>
          <img />
        <% end %>
        <span class="title">{@series.title}</span>
      </.link>
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
