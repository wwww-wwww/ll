defmodule LLWeb.PageController do
  use LLWeb, :controller

  def routes(conn, _params) do
    render(conn, "routes.html")
  end
end
