defmodule LLWeb.StatusLive do
  use LLWeb, :live_view

  @topic "status-updates"

  def title(), do: "Status"

  def render(assigns) do
    ~H"""
    <h1>Status</h1>

    <table>
      <tr :for={{key, value} <- @status}>
        <td>{key_string(key)}</td>
        <td>{value}</td>
      </tr>
    </table>

    <h2>Working</h2>
    <table>
      <tr :for={t <- @downloader_working}>
        <td>{t.time}</td>
        <td>{t.url}</td>
      </tr>
    </table>
    <h2>Queue</h2>
    <table>
      <tr :for={t <- @downloader_queue}>
        <td>{t.time}</td>
        <td>{t.url}</td>
      </tr>
    </table>
    """
  end

  def key_string(key) do
    case key do
      {a, b} ->
        key =
          to_string(a)
          |> String.split(".")
          |> Enum.at(-1)

        "{#{key}, #{b}}"

      a ->
        a
    end
  end

  def status() do
    LL.Status.all()
    |> Enum.sort_by(&elem(&1, 0))
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe(@topic)
      Endpoint.subscribe("worker-queue:downloader")
    end

    downloader = LL.Downloader.manager(:downloader)

    {a, b} = downloader.queue
    queue = (a ++ Enum.reverse(b)) |> Enum.reverse()

    socket =
      socket
      |> assign(status: status())
      |> assign(page_title: "Status")
      |> assign(downloader_queue: queue)
      |> assign(downloader_working: downloader.working)

    {:ok, socket}
  end

  def handle_info(%{topic: @topic, payload: %{status: status}}, socket) do
    {:noreply, assign(socket, status: status)}
  end

  def handle_info(%{topic: "worker-queue:downloader", payload: {queue, working}}, socket) do
    socket =
      socket
      |> assign(downloader_queue: queue)
      |> assign(downloader_working: working)

    {:noreply, socket}
  end

  def update_queue(queue_name, {a, b}, working) do
    queue = (a ++ Enum.reverse(b)) |> Enum.reverse()
    Endpoint.broadcast("worker-queue:#{queue_name}", "update", {queue, working})
  end

  def update() do
    Endpoint.broadcast(@topic, "status:update", %{status: status()})
  end
end
