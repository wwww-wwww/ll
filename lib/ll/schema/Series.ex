defmodule LL.Series do
  use Ecto.Schema

  schema "series" do
    field :title, :string
    field :description, :string
    field :type, :string

    field :cover, :string

    belongs_to :source, LL.Source
    field :source_remote_id, :string

    has_many :chapters, LL.Chapter
    many_to_many :tags, LL.Tag, join_through: LL.SeriesTags, on_replace: :delete

    timestamps()
  end
end
