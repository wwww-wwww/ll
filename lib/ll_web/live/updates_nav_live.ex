defmodule LLWeb.UpdatesNavLive do
  use LLWeb, :live_view

  alias LL.{Repo, Message}

  def render(assigns) do
    ~H"""
    <.nav socket={@socket} view={LLWeb.UpdatesLive} />
    """
  end

  def mount(_params, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("messages")
    end

    {:ok, socket}
  end
end
