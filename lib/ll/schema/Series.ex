defmodule LL.Series do
  use Ecto.Schema

  schema "series" do
    field :anilist_id, :integer
    field :title, :string
    field :artist, :string
    field :author, :string
    field :description, :string
    field :genre, :string
    field :status, :integer
    field :thumbnail_path, :string
    field :details_updated, :utc_datetime

    field :reading_mode, Ecto.Enum, values: [:rtl, :ltr, :continuous], default: :rtl

    belongs_to :source, LL.Source
    field :url, :string

    has_many :chapters, LL.Chapter
    field :chapters_updated, :utc_datetime

    belongs_to :multi_series, LL.MultiSeries
    field :priority, :integer

    timestamps()
  end
end
