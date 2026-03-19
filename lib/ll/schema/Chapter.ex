defmodule LL.Chapter do
  use Ecto.Schema

  schema "chapters" do
    field :number, :integer
    field :title, :string
    field :date, :date

    field :cover, :string
    field :files, {:array, :string}

    belongs_to :source, LL.Source
    field :source_remote_id, :string

    belongs_to :series, LL.Series, type: :string
    many_to_many :tags, LL.Tag, join_through: LL.ChaptersTags, on_replace: :delete

    timestamps()
  end
end
