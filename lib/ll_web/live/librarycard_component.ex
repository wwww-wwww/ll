defmodule LLWeb.LibraryCard do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="library-card">
      <.link navigate={~p"/series/#{@series.id}"}>
          <%= if @series.thumbnail_path != nil and File.exists?(@series.thumbnail_path) do %>
              <img src={~p"/thumbnail/#{Path.basename(@series.thumbnail_path)}"}/>
          <% else %>
              <img/>
          <% end %>
          <span><%= @series.title %></span>
      </.link>
    </div>
    """
  end

  def update(assigns, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("series:#{assigns.series.id}")
    end

    socket = assign(socket, assigns)

    {:ok, socket}
  end
end
