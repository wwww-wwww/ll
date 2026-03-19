defmodule LLWeb.RoutesLive do
  use LLWeb, :live_view

  def title(), do: "Routes"

  def render(assigns) do
    LLWeb.PageView.render("routes.html", assigns)
  end

  def mount(_, _session, socket) do
    socket = assign(socket, page_title: "Routes")
    {:ok, socket}
  end
end
