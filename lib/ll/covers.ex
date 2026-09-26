defmodule LL.Covers do
  alias LL.{Repo, Series, MultiSeries}

  def encode(path) do
    filename = Path.basename(path)
    thumbnail_path = "thumbnails/#{filename}"
    System.cmd("uv", ["run", "covers.py", path, thumbnail_path])
    thumbnail_path
  end

  def encode_all() do
    LL.Repo.all(Series)
    []
    |> Kernel.++(LL.Repo.all(MultiSeries))
    |> Enum.filter(&(!is_nil(&1.thumbnail_path)))
    |> Enum.each(fn %{thumbnail_path: path} ->
      if File.exists?("covers/#{Path.basename(path)}") do
        encode(path) |> IO.inspect
      end
    end)
  end
end
