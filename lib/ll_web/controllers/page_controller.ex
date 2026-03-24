defmodule LLWeb.PageController do
  use LLWeb, :controller

  alias LL.{Repo, Chapter}

  def mime(path) do
    cond do
      String.ends_with?(path, ".jxl") -> "image/jxl"
      String.ends_with?(path, ".jxl.jpg") -> "image/jxl"
      true -> MIME.from_path(path)
    end
  end

  def page(conn, %{"chapter" => id, "index" => index}) do
    with %Chapter{} = chapter <- Repo.get(Chapter, id),
         {index, _} <- Integer.parse(index),
         path <- chapter.files |> Enum.at(index - 1),
         true <- File.exists?(path) do
      conn
      |> put_resp_content_type(mime(path))
      |> send_file(200, path)
    else
      _ ->
        conn |> put_status(404) |> text("File not found")
    end
  end
end
