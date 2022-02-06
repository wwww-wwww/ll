defmodule LLWeb.StatusLive do
  use LLWeb, :live_view

  @topic "status-updates"

  def render(assigns) do
    LLWeb.PageView.render("status.html", assigns)
  end

  def status() do
    LL.Status.all()
    |> Enum.sort_by(&elem(&1, 0))
  end

  def mount(_, _session, socket) do
    if connected?(socket), do: LLWeb.Endpoint.subscribe(@topic)

    socket =
      socket
      |> assign(status: status())

    {:ok, socket}
  end

  def handle_info(%{topic: @topic, payload: %{status: status}}, socket) do
    {:noreply, assign(socket, status: status)}
  end

  def update() do
    LLWeb.Endpoint.broadcast(@topic, "status:update", %{status: status()})
  end
end
