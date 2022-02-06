defmodule LLWeb.PageController do
  use LLWeb, :controller

  def reader(conn, _params) do
    render(conn, "reader.html")
  end
end
