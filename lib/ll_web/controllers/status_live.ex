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

  def handle_event("sync", _, socket) do
    downloader = LL.Downloader.get()

    if length(downloader.working) == 0 and :queue.len(downloader.queue) == 0 do
      LL.sync_assoc()
      LL.update_covers()
      LL.sync_pages()
      LL.sync()
    end

    {:noreply, socket}
  end

  def handle_event("encode_pages", _, socket) do
    encoder = LL.Encoder.get()

    if length(encoder.working) == 0 and :queue.len(encoder.queue) == 0 do
      LL.encode_pages(true)
    end

    {:noreply, socket}
  end

  def update() do
    LLWeb.Endpoint.broadcast(@topic, "status:update", %{status: status()})
  end
end
