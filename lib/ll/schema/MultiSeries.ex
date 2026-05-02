defmodule LL.MultiSeries do
  use Ecto.Schema

  schema "multiseries" do
    belongs_to :series, LL.Series

    has_many :children, LL.Series, foreign_key: :multiseries_id

    many_to_many :categories, LL.Category,
      join_through: LL.MultiSeriesCategory,
      join_keys: [multiseries_id: :id, category_id: :id]
  end

  def get_chapters(multi, show_all \\ false) do
    multi =
      multi
      |> LL.Repo.preload(series: [:chapters], children: [:chapters])

    series = [{multi.series, true}] ++ Enum.map(multi.children, &{&1, false})

    series
    |> Enum.map(fn {s, is_main} ->
      Enum.map(s.chapters, fn c -> {s, c, is_main} end)
    end)
    |> List.flatten()
    |> Enum.sort_by(fn {s, c, is_main} -> {c.number, s.priority, is_main} end, :desc)
    |> Enum.map(&{elem(&1, 0), elem(&1, 1)})
    |> Enum.uniq_by(&elem(&1, 1).number)
    |> Enum.filter(&(show_all or elem(&1, 1).hidden != true))
  end
end
