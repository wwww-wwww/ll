defmodule LLWeb.UpdatesLive do
  use LLWeb, :live_view

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

  def handle_info(%{topic: "messages", event: "create", payload: message}, socket) do
    socket = assign(socket, messages: socket.assigns.messages ++ [message])
    {:noreply, socket}
  end
end
