defmodule LL.Paths do
  alias LL.{Chapter, Series, Repo}

  def root(), do: Application.get_env(:ll, :downloads_root)

  def get(%Series{} = series) do
    name = String.replace(series.title, ~r/[^ a-zA-Z0-9\.\-\_]/, "") |> String.trim()
    name = "#{name}-#{series.source.lang}-#{series.source.name}-#{series.id}"
    Path.expand(root()) |> Path.join(name)
  end

  def get(%Chapter{} = chapter) do
    title = String.replace(chapter.title, ~r/[^ a-zA-Z0-9\.\-\_]/, "") |> String.trim()

    name =
      if chapter.number > 0 do
        "#{chapter.number}-#{title}"
      else
        title
      end

    name = "#{name}-#{chapter.scanlator}-#{chapter.id}"

    Repo.get(Series, chapter.series_id)
    |> Repo.preload(:source)
    |> get()
    |> Path.join(name)
  end
end
