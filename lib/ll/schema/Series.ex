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
    field :categories, {:array, :string}

    field :details_updated, :utc_datetime
    field :chapters_updated, :utc_datetime

    has_many :chapters, LL.Chapter
    many_to_many :tags, LL.Tag, join_through: LL.SeriesTags, on_replace: :delete

    timestamps()
  end
end
