defmodule LLWeb.SeriesPageComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="SeriesPageComponent" }>
      <div class="header">
        <button phx-click="close_series" class="material-symbols-rounded">close</button>
      </div>
      <div class="body" phx-value-sid={@series_id}>
        {live_render(@socket, LLWeb.SeriesLive,
          id: "#{LLWeb.SeriesLive}:#{@series_id}#{if assigns[:is_multi], do: ":multi"}",
          session: %{"series_id" => @series_id, "is_multi" => assigns[:is_multi]}
        )}
      </div>
    </div>
    """
  end
end
