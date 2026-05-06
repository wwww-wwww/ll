defmodule LLWeb.ExtensionsLive do
  use LLWeb, :live_view

  require LL.Downloader

  alias LL.ExtensionManager

  def title(), do: "Extensions"

  def render(assigns) do
    ~H"""
    <h1>Extensions</h1>

    <button phx-click="update_remote">Update remote</button>
    <button phx-click="update_local">Update local</button>

    <h3>Installed</h3>
    <table>
      <tr :for={{pkg, ext} <- @local}>
        <td>
          <img loading="lazy" src={"#{ExtensionManager.extension_repo()}icon/#{ext.pkg}.png"} />
        </td>
        <td>{ext.sources |> Enum.at(0) |> Map.get(:name)}</td>
        <td>{ext.version}</td>
        <td>{ext.pkg}</td>
        <td :if={Map.has_key?(@remote, pkg) and @remote[pkg].version != ext.version}>
          <button phx-click="install" phx-value-pkg={ext.pkg} phx-disable-with="Updating...">
            Update to {@remote[pkg].version}
          </button>
        </td>
      </tr>
    </table>

    <h3>Remote</h3>
    <table>
      <tr :for={
        {_, ext} <-
          Enum.filter(@remote, fn r ->
            not Enum.any?(@local, fn l ->
              elem(r, 0) == elem(l, 0)
            end)
          end)
      }>
        <td><button phx-click="install" phx-value-pkg={ext.pkg}>Install</button></td>
        <td>
          <img loading="lazy" src={"#{LL.ExtensionManager.extension_repo()}icon/#{ext.pkg}.png"} />
        </td>
        <td class="details">
          <div>
            <span>{ext.sources |> Enum.at(0) |> Map.get(:name)}</span>
            <span>{ext.lang} - {ext.version}</span>
          </div>
        </td>
        <td>{ext.pkg}</td>
      </tr>
    </table>
    """
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
