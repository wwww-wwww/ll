defmodule LL.Covers do
  alias LL.{Repo, Anilist}

  def encode(path) do
    filename = Path.basename(path)
    thumbnail_path = "thumbnails/#{filename}.webp"
    System.cmd("uv", ["run", "covers.py", path, thumbnail_path])
    thumbnail_path
  end

  def encode_all() do
    Repo.all(Anilist)
    |> Enum.filter(&(!is_nil(&1.thumbnail_path)))
    |> Enum.each(fn %{thumbnail_path: path} = anilist ->
      if File.exists?("covers/#{Path.basename(path)}") do
        IO.inspect(path)
        thumbnail_path = encode(path)

        anilist
        |> Ecto.Changeset.change(%{thumbnail_path: thumbnail_path})
        |> Repo.update()
      end
    end)
  end
end
