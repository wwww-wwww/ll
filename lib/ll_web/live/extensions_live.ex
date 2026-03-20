defmodule LLWeb.ExtensionsLive do
  use LLWeb, :live_view

  require LL.Downloader

  alias LL.{Extension, Downloader, ExtensionManager}

  @topic to_string(__MODULE__)

  def title(_socket), do: "Extensions"

  def render(assigns) do
    LLWeb.PageView.render("extensions.html", assigns)
  end

  def mount(_, _session, socket) do
    if connected?(socket), do: LLWeb.Endpoint.subscribe(@topic)

    manager = ExtensionManager.get()

    socket =
      socket
      |> assign(remote: manager.remote)
      |> assign(local: manager.local)

    {:ok, socket}
  end

  def update_remote(arr) do
    LLWeb.Endpoint.broadcast(@topic, "update_assigns", {:remote, arr})
  end

  def update_local(arr) do
    LLWeb.Endpoint.broadcast(@topic, "update_assigns", {:local, arr})
  end

  def handle_info(%{topic: @topic, event: "update_assigns", payload: {key, val}}, socket) do
    socket = assign(socket, key, val)

    {:noreply, socket}
  end

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
