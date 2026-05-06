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
    if connected?(socket), do: Endpoint.subscribe(@topic)

    socket =
      socket
      |> assign(status: status())
      |> assign(page_title: "Status")

    {:ok, socket}
  end

  def handle_info(%{topic: @topic, payload: %{status: status}}, socket) do
    {:noreply, assign(socket, status: status)}
  end

  def update() do
    Endpoint.broadcast(@topic, "status:update", %{status: status()})
  end
end
