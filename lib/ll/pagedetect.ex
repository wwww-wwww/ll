defmodule LL.PageDetect do
  alias LL.{Repo, Chapter}

  def detect(%Chapter{files: files} = chapter) do
    files =
      Enum.map(files, fn path ->
        {:file, path, {"form-data", [name: "files", filename: Path.basename(path)]}, []}
      end)

    body = {:multipart, files}

    with {:ok, %{body: body}} <- HTTPoison.post("http://localhost:14010", body),
         {:ok, j} <- Jason.decode(body) do
      IO.inspect(j)

      Ecto.Changeset.change(chapter, %{page_order: j})
      |> Repo.update()
    else
      err -> IO.inspect(err)
    end
  end
end
