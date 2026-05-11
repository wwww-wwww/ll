defmodule LLWeb.UpdatesNavLive do
  use LLWeb, :live_view

  alias LL.{Repo, Message}

  def render(assigns) do
    ~H"""
    <.link navigate={~p"/updates"} class={current_page?(@socket, LLWeb.UpdatesLive)}>
      Updates
      <%= if @count > 0 do %>
        ({@count})
      <% end %>
    </.link>
    """
  end

  def mount(_params, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("message_count")
    end

    count = Repo.aggregate(Message, :count, :id)
    socket = assign(socket, count: count)

    {:ok, socket}
  end

  def handle_info(%{topic: "message_count", payload: n}, socket) do
    {:noreply, assign(socket, count: n)}
  end
end
