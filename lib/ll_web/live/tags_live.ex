defmodule LLWeb.TagsLive do
  use LLWeb, :live_view

  def render(assigns) do
    LLWeb.PageView.render("tags.html", assigns)
  end

  def mount(_, _session, socket) do
    socket = assign(socket, page_title: "Tags")
    {:ok, socket}
  end
end
