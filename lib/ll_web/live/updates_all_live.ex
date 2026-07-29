defmodule LLWeb.UpdatesAllLive do
  use LLWeb, :live_view

  import Ecto.Query, only: [from: 2]
  import LLWeb.UpdatesLive, only: [replace_links: 1]

  alias LL.{Repo, Message}

  def title(), do: "Updates"

  def render(assigns) do
    ~H"""
    <h1>Updates</h1>

    <div class="messages">
      <button :if={LL.User.mod?(@current_scope)} phx-click="clear-errors" style="align-self: start">
        Clear errors
      </button>
      <div :for={e <- @messages |> Enum.sort_by(& &1.inserted_at, {:desc, NaiveDateTime})}>
        <div>
          <button
            :if={LL.User.mod?(@current_scope)}
            phx-click="delete"
            phx-value-id={e.id}
            class="material-symbols-rounded"
          >
            close
          </button>
          <span>{relative_time(e.inserted_at)}</span>
          <span>{replace_links(e.title)}</span>
        </div>
        <div :if={e.body != ""}>{replace_links(e.body)}</div>
      </div>
    </div>
    """
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("messages")
    end

    messages = Repo.all(Message)

    socket =
      socket
      |> assign(messages: messages)

    {:ok, socket}
  end

  def handle_event("clear-errors", _params, socket) do
    from(m in Message, where: m.title == "Error")
    |> Repo.all()
    |> Enum.each(&delete/1)

    {:noreply, socket}
  end

  def handle_event("delete", %{"id" => id}, socket) do
    case Repo.get(Message, id) do
      nil -> nil
      message -> delete(message)
    end

    {:noreply, socket}
  end

  def handle_info(%{topic: "messages", event: "create", payload: message}, socket) do
    messages = socket.assigns.messages ++ [message]
    {:noreply, assign(socket, messages: messages)}
  end

  def handle_info(%{topic: "messages", event: "delete", payload: message}, socket) do
    messages = socket.assigns.messages |> Enum.reject(&(&1.id == message.id))
    {:noreply, assign(socket, messages: messages)}
  end

  def delete(message) do
    Repo.delete(message)
    LLWeb.Endpoint.broadcast("messages", "delete", message)
  end
end
