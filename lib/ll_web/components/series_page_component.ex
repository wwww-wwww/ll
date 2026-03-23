defmodule LLWeb.SeriesPageComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesPageComponent" id={"#{__MODULE__}#{assigns[:id]}"}>
      <div class="header">
        <%= if assigns[:close] do %>
          <.link navigate={assigns[:close]} class="button" draggable="false">Close</.link>
        <% else %>
          <button phx-click="close_series">Close</button>
        <% end %>
      </div>
      <div class="body">
        {live_render(@socket, LLWeb.SeriesLive,
          id: LLWeb.SeriesLive,
          session: %{"id" => @series_id}
        )}
      </div>
    </div>
    """
  end
end
