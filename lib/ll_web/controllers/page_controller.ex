defmodule LLWeb.PageController do
  use LLWeb, :controller

  def routes(conn, _params) do
    render(conn, "routes.html")
  end

  def mime(path) do
    cond do
      String.ends_with?(path, ".jxl") -> "image/jxl"
      String.ends_with?(path, ".jxl.jpg") -> "image/jxl"
      true -> MIME.from_path(path)
    end
  end

  def file(conn, %{"path" => path}) do
    path = "files/#{path}"

    if File.exists?(path) do
      case mime(path) do
        "image/jxl" = m ->
          case conn do
            %{req_headers: req_headers} ->
              case req_headers |> Enum.filter(&(elem(&1, 0) == "accept")) do
                [{"accept", accepts}] ->
                  if accepts == "*/*" or "image/jxl" in String.split(accepts, ",") do
                    conn
                    |> put_resp_content_type(m)
                    |> send_file(200, path)
                  else
                    conn
                    |> put_resp_content_type("image/png")
                    |> send_file(200, "files/unsupported.png")
                  end

                _ ->
                  conn
                  |> put_resp_content_type(m)
                  |> send_file(200, path)
              end

            _ ->
              conn
              |> put_resp_content_type(m)
              |> send_file(200, path)
          end

        m ->
          conn
          |> put_resp_content_type(m)
          |> send_file(200, path)
      end
    else
      conn |> put_status(404) |> text("File not found")
    end
  end
end
