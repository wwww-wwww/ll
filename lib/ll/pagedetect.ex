defmodule LL.PageDetect do
  alias LL.{Repo, Chapter}

  require Logger

  def detect(%Chapter{files: files} = chapter) do
    Logger.info("Detecting #{Enum.at(files, 0)}")

    files =
      Enum.map(files, fn path ->
        {:file, path, {"form-data", [name: "files", filename: Path.basename(path)]}, []}
      end)

    body = {:multipart, files}

    with {:ok, %{body: body}} <- HTTPoison.post("http://localhost:14010", body),
         {:ok, j} <- Jason.decode(body) do
      write_exif(chapter.files, j)

      Ecto.Changeset.change(chapter, %{page_order: j})
      |> Repo.update()
    else
      err -> IO.inspect(err)
    end
  end

  def write_exif(file, pos, retry \\ true) when is_binary(file) do
    Logger.info("Writing exif #{file}")

    case System.cmd(
           "exiv2",
           ["-M", "set Exif.Image.PageName #{pos}", file],
           stderr_to_stdout: true
         ) do
      {_, 0} ->
        true

      {out, 1} ->
        if String.contains?(out, "Size of XMP JPEG segment is larger than 65535 bytes") do
          Logger.warning(out)

          if retry do
            System.cmd("exiv2", ["-M", "del Xmp.xmpMM.History", file], stderr_to_stdout: true)
            |> inspect()
            |> Logger.info()

            write_exif(file, pos, false)
          else
            false
          end
        else
          Logger.warning(out)
          false
        end
    end
  end

  def write_exif(files, order, _) do
    order =
      Enum.map(order, fn order ->
        case order do
          1 -> "Left"
          0 -> "Right"
          2 -> "Center"
        end
      end)

    Enum.zip(files, order)
    |> Enum.each(fn {f, pos} -> write_exif(f, pos) end)
  end
end
