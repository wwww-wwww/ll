defmodule LLWeb.ReaderLiveS do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  alias LL.{Repo, Chapter}

  def title(), do: "Reader"

  def render(assigns) do
    ~H"""
    <div id="reader" phx-hook="Reader" phx-update="ignore">
      <canvas></canvas>
      <div class="info">
        <span class="page"></span>
        <span class="zoom"></span>
      </div>
    </div>
    """
  end

  def mount(_params, _session, socket) do
    {:ok, socket}
  end
end
