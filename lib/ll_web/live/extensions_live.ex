defmodule LLWeb.ExtensionsLive do
  use LLWeb, :live_view

  require LL.Downloader

  alias LL.ExtensionManager

  def title(), do: "Extensions"

  def render(assigns) do
    LLWeb.PageView.render("extensions.html", assigns)
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("extensions")
    end

    manager = ExtensionManager.get()

    socket =
      socket
      |> assign(remote: manager.remote)
      |> assign(local: manager.local)

    {:ok, socket}
  end

  def handle_info(%{event: "local", payload: arr}, socket),
    do: {:noreply, assign(socket, local: arr)}

  def handle_info(%{event: "remote", payload: arr}, socket),
    do: {:noreply, assign(socket, remote: arr)}

  def handle_event("update_remote", _params, socket) do
    ExtensionManager.update_remote()
    {:noreply, socket}
  end

  def handle_event("update_local", _params, socket) do
    ExtensionManager.update_local()
    {:noreply, socket}
  end

  def handle_event("install", %{"pkg" => pkg}, socket) do
    ExtensionManager.install(pkg)
    {:noreply, socket}
  end
end
