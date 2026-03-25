defmodule LL do
  @moduledoc """
  LL keeps the contexts that define your domain
  and business logic.

  Contexts are also responsible for managing your data, regardless
  if it comes from the database, an external API or others.
  """

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Downloader, Chapter, Series, Extension}

  def files_root(), do: Application.get_env(:ll, :files_root)

  def migrate(path_from, path_to) do
    Repo.transact(fn ->
      Repo.all(Chapter)
      |> Enum.each(fn e ->
        files =
          case e.files do
            nil -> nil
            files -> files |> Enum.map(&String.replace(&1, path_from, path_to))
          end

        Ecto.Changeset.change(e, %{
          files: files
        })
        |> Repo.update()
      end)

      Repo.all(Extension)
      |> Enum.each(fn e ->
        Ecto.Changeset.change(e, %{
          path: e.path |> String.replace(path_from, path_to)
        })
        |> Repo.update()
      end)

      Repo.all(Series)
      |> Enum.each(fn e ->
        thumbnail_path =
          case e.thumbnail_path do
            nil -> nil
            thumbnail_path -> thumbnail_path |> String.replace(path_from, path_to)
          end

        Ecto.Changeset.change(e, %{
          thumbnail_path: thumbnail_path
        })
        |> Repo.update()
      end)

      {:ok, nil}
    end)
  end

  def prune() do
    from(s in Series, where: s.in_library != true)
    |> Repo.all()
    |> Enum.each(&Repo.delete(&1))
  end

  def cleanup() do
    series =
      from(s in Series, where: s.in_library == true)
      |> Repo.all()
      |> Enum.map(&Path.expand(&1.thumbnail_path))

    File.ls!("thumbnails")
    |> Enum.map(&Path.expand(Path.join("thumbnails", &1)))
    |> Enum.reject(&(&1 in series))
    |> Enum.each(&File.rm(&1))
  end
end
