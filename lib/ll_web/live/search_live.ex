defmodule LLWeb.SearchLive do
  use LLWeb, :live_view

  def title(), do: "Search"

  def render(assigns) do
    LLWeb.PageView.render("search.html", assigns)
  end

  def mount(_, _session, socket) do
    socket =
      socket
      |> assign(search: %{query: ""})
      |> assign(sources: LL.SourceManager.get().sources)
      |> assign(results: %{})

    {:ok, socket}
  end

  def handle_event("search", %{"query" => query}, socket) do
    IO.inspect(query)
    {:noreply, socket}
  end
end
