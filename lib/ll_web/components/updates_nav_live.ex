defmodule LLWeb.UpdatesNavLive do
  use LLWeb, :live_view

  alias LL.{Repo, Message, MessagesUser}

  import Ecto.Query, only: [from: 2]

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

  def mount(_params, %{"user" => user}, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("message_count:#{user.id}")
    end

    socket = assign(socket, count: MessagesUser.count(user))

    {:ok, socket}
  end

  def handle_info(%{topic: "message_count:" <> _user_id, event: "new"}, socket) do
    {:noreply, assign(socket, count: socket.assigns.count + 1)}
  end

  def handle_info(%{topic: "message_count:" <> _user_id, payload: n}, socket) do
    {:noreply, assign(socket, count: n)}
  end
end
