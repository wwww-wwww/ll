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
      LLWeb.Endpoint.subscribe("message_count")
    end

    count =
      from(m in Message,
        join: u in MessagesUser,
        on: u.message_id == m.id,
        where: u.user_id == ^user.id
      )
      |> Repo.aggregate(:count, :id)

    socket = assign(socket, count: count)

    {:ok, socket}
  end

  def handle_info(%{topic: "message_count", payload: n}, socket) do
    {:noreply, assign(socket, count: n)}
  end
end
