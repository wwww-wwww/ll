defmodule LL.MultiSeries do
  use Ecto.Schema

  schema "multi_series" do
    belongs_to :series, LL.Series

    has_many :children, LL.Series

    many_to_many :categories, LL.Category, join_through: LL.MultiSeriesCategory
  end

  def get_chapters(multi) do
    multi =
      multi
      |> LL.Repo.preload(series: [:chapters, :source], children: [:chapters, :source])

    series = [{multi.series, true}] ++ Enum.map(multi.children, &{&1, false})

    series
    |> Enum.map(fn {s, is_main} -> Enum.map(s.chapters, fn c -> {s, c, is_main} end) end)
    |> List.flatten()
    |> Enum.sort_by(fn {s, c, is_main} -> {c.number, is_main, c.scanlator, c.date} end, :desc)
    |> Enum.uniq_by(&elem(&1, 1).number)
    |> Enum.map(&{elem(&1, 0), elem(&1, 1)})
  end
end
