defmodule LLWeb.PageController do
  use LLWeb, :controller

  def mime(path) do
    cond do
      String.ends_with?(path, ".jxl") -> "image/jxl"
      String.ends_with?(path, ".jxl.jpg") -> "image/jxl"
      true -> MIME.from_path(path)
    end
  end

  def file(conn, %{"path" => path}) do
    path = "/tank/llm/files/#{path}"

    if File.exists?(path) do
      conn
      |> put_resp_content_type(mime(path))
      |> send_file(200, path)
    else
      conn |> put_status(404) |> text("File not found")
    end
  end
end
