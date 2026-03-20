defmodule LL.Chapter do
  use Ecto.Schema

  schema "chapters" do
    belongs_to :source, LL.Source
    belongs_to :series, LL.Series
    field :url, :string

    field :title, :string
    field :number, :integer
    field :date, :date
    field :scanlator, :string

    field :files, {:array, :string}

    many_to_many :tags, LL.Tag, join_through: LL.ChaptersTags, on_replace: :delete

    timestamps()
  end
end
