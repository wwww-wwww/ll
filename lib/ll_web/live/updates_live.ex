defmodule LLWeb.UpdatesLive do
  use LLWeb, :live_view

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Message}

  def title(), do: "Updates"

  def render(assigns) do
    LLWeb.PageView.render("updates.html", assigns)
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
    |> Enum.each(&Repo.delete/1)

    {:noreply, socket}
  end

  def handle_event("delete", %{"id" => id}, socket) do
    Repo.get(Message, id) |> Message.delete()
    {:noreply, socket}
  end

  def handle_info(%{topic: "messages", event: "create", payload: message}, socket) do
    socket = assign(socket, messages: socket.assigns.messages ++ [message])
    {:noreply, socket}
  end

  def handle_info(%{topic: "messages", event: "delete", payload: message}, socket) do
    socket =
      assign(socket, messages: socket.assigns.messages |> Enum.reject(&(&1.id == message.id)))

    {:noreply, socket}
  end
end
