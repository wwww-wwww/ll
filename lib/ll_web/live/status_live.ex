defmodule LLWeb.StatusLive do
  use LLWeb, :live_view

  @topic "status-updates"

  def title(), do: "Status"

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
      |> assign(page_title: "Status")

    {:ok, socket}
  end

  def handle_info(%{topic: @topic, payload: %{status: status}}, socket) do
    {:noreply, assign(socket, status: status)}
  end

  def handle_event("sync", _, socket) do
    # LL.sync_all()

    {:noreply, socket}
  end

  def handle_event("sync_series", _, socket) do
    # LL.sync_series()

    {:noreply, socket}
  end

  def handle_event("encode_pages", _, socket) do
    # LL.encode_missing()

    {:noreply, socket}
  end

  def update() do
    LLWeb.Endpoint.broadcast(@topic, "status:update", %{status: status()})
  end
end
