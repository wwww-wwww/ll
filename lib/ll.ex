defmodule LL do
  @moduledoc """
  LL keeps the contexts that define your domain
  and business logic.

  Contexts are also responsible for managing your data, regardless
  if it comes from the database, an external API or others.
  """

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Chapter, Library, Series, Extension, ExtensionManager}

  def sync_chapters() do
    from(l in Library, where: is_nil(l.user_id) and l.name == "Update")
    |> Repo.one()
    |> Repo.preload(:series)
    |> Map.get(:series)
    |> Enum.each(&ExtensionManager.series_chapters(&1, true))
  end

  def migrate_chapters() do
    Repo.transact(fn ->
      Repo.all(Chapter)
      |> Enum.filter(fn c -> c.files != nil and Enum.all?(c.files, &File.exists?(&1)) end)
      |> Enum.each(fn c ->
        chapter_path = LL.Paths.get(c)
        :ok = File.mkdir_p(chapter_path)

        files =
          Enum.map(c.files, fn f ->
            new_path = Path.join(chapter_path, Path.basename(f))
            :ok = File.cp(f, new_path)
            new_path
          end)

        Ecto.Changeset.change(c, %{
          files: files
        })
        |> Repo.update()
      end)

      {:ok, nil}
    end)
  end

  def migrate(path_from, path_to) do
    Repo.transact(fn ->
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

  def pagedetect_missing() do
    LL.Repo.all(LL.Chapter)
    |> Enum.filter(&LL.Chapter.downloaded?/1)
    |> Enum.each(&LL.PageDetect.detect/1)
  end
end
