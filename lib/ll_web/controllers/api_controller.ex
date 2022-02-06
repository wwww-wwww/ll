defmodule LLWeb.ApiController do
  use LLWeb, :controller


  def all(conn, _params) do
    conn |> json(%{})
  end
end
