defmodule LLWeb.RoutesLive do
  use LLWeb, :live_view

  def title(), do: "Routes"

  def render(assigns) do
    ~H"""
    <h1>Routes</h1>

    <ul>
      <%= for route <- Phoenix.Router.routes(LLWeb.Router) do %>
        <li>
          <%= if Map.get(route.metadata, :phoenix_live_view) do %>
            live <.link navigate={route.path}>"{route.path}"</.link>, {Map.get(
              route.metadata,
              :phoenix_live_view
            )
            |> elem(0)},
            :{route.plug_opts}
          <% else %>
            {route.verb} <.link navigate={route.path}>"{route.path}"</.link>, {route.plug}, :{route.plug_opts}
          <% end %>
        </li>
      <% end %>
    </ul>

    <%= if function_exported?(Routes, :live_dashboard_path, 2) do %>
      <.link navigate={Routes.live_dashboard_path(@socket, :home)}>LiveDashboard</.link>
    <% end %>
    """
  end

  def mount(_, _session, socket) do
    socket = assign(socket, page_title: "Routes")
    {:ok, socket}
  end
end
