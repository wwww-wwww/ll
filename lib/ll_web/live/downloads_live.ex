defmodule LLWeb.DownloadsLive do
  use LLWeb, :live_view

  def title(), do: "Downloads"

  def render(assigns) do
    LLWeb.PageView.render("downloads.html", assigns)
  end

  def mount(_, _session, socket) do
    {:ok, socket}
  end
end
