defmodule LLWeb.SeriesPageComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesPageComponent">
      <div class="header">
        <%= if assigns[:close] do %>
          <.link navigate={assigns[:close]} class="button material-symbols-rounded" draggable="false">
            close
          </.link>
        <% else %>
          <button phx-click="close_series" class="material-symbols-rounded">close</button>
        <% end %>
      </div>
      <div class="body" phx-value-sid={@series_id}>
        {live_render(@socket, LLWeb.SeriesLive,
          id: "#{LLWeb.SeriesLive}:#{@series_id}",
          session: %{"id" => @series_id}
        )}
      </div>
    </div>
    """
  end
end
