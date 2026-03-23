defmodule LLWeb.NotificationsComponent do
  use LLWeb, :live_component

  def render(assigns) do
    ~H"""
    <div class="NotificationsComponent"></div>
    """
  end

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("notifications")
      |> assign(assigns)

    {:ok, socket}
  end

  defmacro __using__(_opts) do
    quote do
      def handle_info(%{topic: "notifications", event: "update", payload: notifications}, socket) do
        LLWeb.NotificationsComponent.update_assigns(0, notifications: notifications)
        {:noreply, socket}
      end
    end
  end
end
