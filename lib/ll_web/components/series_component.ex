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
          <img
            :if={@series.thumbnail_path != nil and File.exists?(@series.thumbnail_path)}
            src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"}
          />
          <span class="title">{@series.title}</span>
        </.link>
      <% end %>
    </div>
    """
  end

  def update(assigns, socket) do
    socket =
      case assigns[:series] do
        %LL.MultiSeries{} -> subscribe_once(socket, "thumb:multi:#{assigns.series.id}")
        %LL.Series{} -> subscribe_once(socket, "thumb:series:#{assigns.series.id}")
      end
      |> assign(assigns)

    {:ok, socket}
  end

  defmacro __using__(_opts) do
    quote do
      def handle_info(%{topic: "thumb:multi:" <> _, event: "update", payload: series}, socket) do
        LLWeb.SeriesComponent.update_assigns(series.id, series: series)
        {:noreply, socket}
      end

      def handle_info(%{topic: "thumb:series:" <> _, event: "update", payload: series}, socket) do
        LLWeb.SeriesComponent.update_assigns(series.id, series: series)
        {:noreply, socket}
      end
    end
  end
end
