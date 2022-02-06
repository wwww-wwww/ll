defmodule LL.Series do
  use Ecto.Schema

  @primary_key false
  schema "series" do
    field :id, :string, primary_key: true
    field :title, :string
    field :description, :string, size: 4096
    field :source, :string
    field :source_id, :string

    field :cover, :string

    has_many :chapters, LL.Chapter, references: :id
    many_to_many :tags, LL.Tag, join_through: LL.SeriesTags, on_replace: :delete

    timestamps()
  end
end
