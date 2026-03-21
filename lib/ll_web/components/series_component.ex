defmodule LLWeb.SeriesComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesComponent">
      <.link navigate={~p"/series/#{@state.id}"}>
        <%= if @state.thumbnail_path != nil and File.exists?(@state.thumbnail_path) do %>
          <img src={~p"/thumbnail/#{Path.basename(@state.thumbnail_path)}"}/>
        <% else %>
          <img/>
        <% end %>
        <span><%= @state.title %></span>
      </.link>
    </div>
    """
  end

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("series:#{assigns.state.id}")
      |> assign(assigns)

    {:ok, socket}
  end

  defmacro __using__(opts) do
    quote do
      def handle_info(%{topic: "series:" <> _, event: "update", payload: state}, socket) do
        LLWeb.SeriesComponent.send_update(state)
        {:noreply, socket}
      end
    end
  end
end
