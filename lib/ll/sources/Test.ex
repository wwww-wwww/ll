defmodule LL.Sources.Test do
  alias LL.{Chapter, Series, Repo}

  @file_path "files/test"

  def file_path, do: @file_path

  def chapter_url(chapter), do: "test " <> chapter.source_id
  def series_url(chapter), do: "test series " <> chapter.source_id

  def update(%Series{} = series) do
    Path.join(LL.files_root(), @file_path)
    |> File.ls!()
    |> Enum.sort()
    |> Enum.with_index(1)
    |> Enum.each(fn {f, i} ->
      chapter_path = Path.join(@file_path, f)

      files =
        Path.join(LL.files_root(), chapter_path)
        |> File.ls!()
        |> Enum.sort()
        |> Enum.map(&Path.join(chapter_path, &1))

      case Repo.get(LL.Chapter, f) do
        nil ->
          %Chapter{
            id: f,
            title: "Test " <> to_string(i),
            source: "test",
            source_id: f,
            series_id: series.id,
            files: files,
            number: i,
            enc: "",
            enc_params: "",
            original_files: [],
            original_files_sizes: [],
            cover: "covers/test/test_ch01.webp",
            date: DateTime.utc_now() |> DateTime.to_date()
          }
          |> Repo.insert()

        chapter ->
          Ecto.Changeset.change(chapter, files: files, number: i)
          |> Repo.update()
      end
    end)
  end

  def update(%Chapter{} = chapter) do
  end
end
