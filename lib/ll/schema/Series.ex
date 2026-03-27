defmodule LL.Series do
  use Ecto.Schema

  schema "series" do
    belongs_to :source, LL.Source
    field :url, :string

    field :title, :string
    field :artist, :string
    field :author, :string
    field :description, :string
    field :genre, :string
    field :status, :integer

    field :thumbnail_url, :string
    field :thumbnail_path, :string

    field :in_library, :boolean, default: false

    field :details_updated, :utc_datetime
    field :chapters_updated, :utc_datetime

    has_many :chapters, LL.Chapter

    belongs_to :multiseries, LL.MultiSeries
    field :priority, :integer

    many_to_many :categories, LL.Category, join_through: LL.SeriesCategory

    timestamps()
  end
end
