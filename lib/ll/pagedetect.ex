defmodule LL.PageDetect do
  alias LL.{Repo, Chapter}

  def detect(%Chapter{files: files} = chapter) do
    IO.inspect(Enum.at(files, 0))

    files =
      Enum.map(files, fn path ->
        {:file, path, {"form-data", [name: "files", filename: Path.basename(path)]}, []}
      end)

    body = {:multipart, files}

    with {:ok, %{body: body}} <- HTTPoison.post("http://localhost:14010", body),
         {:ok, j} <- Jason.decode(body) do
      write_exif(files, j)

      Ecto.Changeset.change(chapter, %{page_order: j})
      |> Repo.update()
    else
      err -> IO.inspect(err)
    end
  end

  def write_exif(files, order) do
    order =
      Enum.map(order, fn order ->
        case order do
          1 -> "Left"
          0 -> "Right"
          2 -> "Center"
        end
      end)

    Enum.zip(files, order)
    |> Enum.each(fn {f, pos} ->
      IO.inspect(f)
      {_, 0} = System.cmd("exiv2", ["-M", "set Exif.Image.PageName #{pos}", f])
    end)
  end
end
