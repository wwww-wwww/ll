defmodule LL.LocalLibrary do
  import Ecto.Query, only: [from: 2]
  alias LL.{Repo, Series, Chapter, Library, LibrarySeries, Message}

  @images ~w(.jpg .jpeg .png .webp .gif .avif)

  def root(), do: Application.fetch_env!(:ll, :local_root)

  def sync() do
    root = Path.expand(root())

    case File.ls(root) do
      {:ok, names} ->
        for name <- Enum.sort(names),
            File.dir?(Path.join(root, name)),
            do: sync_series(root, name)

        :ok

      err ->
        Message.error(err)
    end
  end

  defp sync_series(root, title) do
    dir = Path.join(root, title)

    series =
      Repo.one(from(s in Series, where: is_nil(s.source_id) and s.title == ^title, limit: 1)) ||
        Repo.insert!(%Series{title: title, details_updated: now(), chapters_updated: now()})

    add_to_library(series)

    {:ok, names} = File.ls(dir)

    folders = Enum.filter(Enum.sort(names), &File.dir?(Path.join(dir, &1)))
    Enum.each(folders, &sync_chapter(series, dir, &1))

    Repo.delete_all(
      from(c in Chapter, where: c.series_id == ^series.id and c.url not in ^folders)
    )

    series
    |> Ecto.Changeset.change(%{chapters_updated: now()})
    |> Repo.update!()
    |> then(&LLWeb.Endpoint.broadcast("chapters:#{&1.id}", "update", Chapter.list(&1)))
  end

  defp add_to_library(series) do
    LL.create_default_libraries()
    library = Repo.one!(from(l in Library, where: is_nil(l.user_id) and l.name == "Local"))

    unless Repo.get_by(LibrarySeries, library_id: library.id, series_id: series.id),
      do: Repo.insert!(%LibrarySeries{library_id: library.id, series_id: series.id})
  end

  defp sync_chapter(series, dir, name) do
    path = Path.join(dir, name)

    files =
      path
      |> File.ls!()
      |> Enum.filter(&(String.downcase(Path.extname(&1)) in @images))
      |> Enum.sort_by(&natural_key/1)
      |> Enum.map(&Path.join(path, &1))

    chapter =
      Repo.get_by(Chapter, series_id: series.id, url: name) ||
        %Chapter{series_id: series.id, url: name}

    {number, title} = parse_name(name)
    title = if title in [nil, ""], do: "Chapter #{format_number(number)}", else: title

    chapter
    |> Ecto.Changeset.change(%{
      title: title,
      number: number,
      date: chapter.date || now(),
      files: files
    })
    |> Repo.insert_or_update!()
  end

  defp now(), do: DateTime.utc_now() |> DateTime.truncate(:second)

  # "2.0" -> {2.0, ""}; "2.0-Animation" -> {2.0, "Animation"}; names without a number get number 0.
  defp parse_name(name) do
    case Regex.run(~r/^(\d+(?:\.\d+)?)(?:-(.+))?$/, String.trim(name)) do
      [_, n] -> {n |> Float.parse() |> elem(0), ""}
      [_, n, title] -> {n |> Float.parse() |> elem(0), title}
      nil -> {0.0, name}
    end
  end

  defp format_number(n) when n == trunc(n), do: trunc(n)
  defp format_number(n), do: n

  # Pads digit runs so "2.png" sorts before "10.png".
  defp natural_key(name) do
    Regex.split(~r/\d+/, name, include_captures: true)
    |> Enum.map(fn part ->
      if part =~ ~r/^\d+$/, do: String.pad_leading(part, 12, "0"), else: part
    end)
  end
end
