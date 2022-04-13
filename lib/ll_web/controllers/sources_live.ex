defmodule LLWeb.SourcesLive do
  use LLWeb, :live_view

  def render(assigns) do
    LLWeb.PageView.render("sources.html", assigns)
  end

  def mount(_, _session, socket) do
    {:ok, socket}
  end
end
