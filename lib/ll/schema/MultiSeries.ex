defmodule LL.MultiSeries do
  use Ecto.Schema

  schema "multi_series" do
    field :anilist_id, :integer
    field :title, :string
    field :artist, :string
    field :author, :string
    field :description, :string
    field :genre, :string
    field :status, :integer
    field :thumbnail_path, :string
    field :details_updated, :utc_datetime

    belongs_to :series, LL.Series

    has_many :children, LL.Series
  end

  def get_chapters(multi) do
    multi =
      multi
      |> LL.Repo.preload(series: [:chapters, :source], children: [:chapters, :source])

    series = [{multi.series, true}] ++ Enum.map(multi.children, &{&1, false})

    series
    |> Enum.map(fn {s, is_main} -> Enum.map(s.chapters, fn c -> {s, c, is_main} end) end)
    |> List.flatten()
    |> Enum.sort_by(fn {_s, c, is_main} -> {c.number, is_main, c.scanlator, c.date} end, :desc)
    |> Enum.uniq_by(&elem(&1, 1).number)
    |> Enum.map(&{elem(&1, 0), elem(&1, 1)})
  end
end
