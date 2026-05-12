defmodule LLWeb.SeriesPageComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesPageComponent">
      <div class="header">
        <button phx-click="close_series" class="material-symbols-rounded">close</button>
      </div>
      <div class="body" phx-value-sid={@series_id}>
        <%= if assigns[:is_multi] do %>
          {live_render(@socket, LLWeb.SeriesLive,
            id: "#{LLWeb.SeriesLive}:#{@series_id}-multi",
            session: %{"multi_id" => @series_id}
          )}
        <% else %>
          {live_render(@socket, LLWeb.SeriesLive,
            id: "#{LLWeb.SeriesLive}:#{@series_id}",
            session: %{"series_id" => @series_id}
          )}
        <% end %>
      </div>
    </div>
    """
  end
end
