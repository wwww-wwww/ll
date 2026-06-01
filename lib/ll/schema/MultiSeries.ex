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
    multi
    |> LL.Repo.preload(children: [:source, :chapters])
    |> Map.get(:children)
    |> Enum.map(fn s -> Enum.map(s.chapters, fn c -> {s, c} end) end)
    |> List.flatten()
    |> Enum.sort_by(fn {s, c} -> c.date end, :desc)
    |> Enum.sort_by(fn {s, c} -> c.scanlator end, :desc)
    |> Enum.sort_by(fn {s, c} -> s.priority end, :asc)
    |> Enum.sort_by(fn {s, c} -> c.hidden || 0 end, :asc)
    |> Enum.sort_by(fn {s, c} -> c.number end, :desc)
    |> Enum.uniq_by(&elem(&1, 1).number)
  end
end
