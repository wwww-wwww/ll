defmodule LLWeb.RoutesLive do
  use LLWeb, :live_view

  def render(assigns) do
    LLWeb.PageView.render("routes.html", assigns)
  end

  def mount(_, _session, socket) do
    {:ok, socket}
  end
end
