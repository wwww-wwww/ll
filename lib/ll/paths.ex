defmodule LL.Paths do
  alias LL.{Chapter, Series, Repo}

  def root(), do: Application.get_env(:ll, :downloads_root)

  def get(%Series{} = series) do
    name =
      "#{series.title}-#{series.source.lang}-#{series.source.name}-#{series.id}"
      |> String.replace(~r/[^ a-zA-Z0-9\.\-\_]/, "")
      |> String.trim()

    Path.expand(root()) |> Path.join(name)
  end

  def get(%Chapter{} = chapter) do
    number =
      if chapter.number > 0,
        do: "#{chapter.number}-",
        else: ""

    title = String.replace(chapter.title, "/", "-") <> "-"

    scanlator =
      if not is_nil(chapter.scanlator),
        do: String.replace(chapter.scanlator, "/", "-") <> "-",
        else: ""

    name =
      "#{number}#{title}#{scanlator}#{chapter.id}"
      |> String.replace(~r/[^ a-zA-Z0-9\.\-\_]/, "")
      |> String.trim()

    Repo.get(Series, chapter.series_id)
    |> Repo.preload(:source)
    |> get()
    |> Path.join(name)
    |> String.downcase()
  end
end
