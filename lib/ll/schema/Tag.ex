defmodule LL.Tag do
  use Ecto.Schema

  @primary_key false
  schema "tags" do
    field :id, :string, primary_key: true
    field :name, :string
    # 0: normal 1: series, 2: author, 3: group, 4: category
    field :type, :integer, default: 0

    many_to_many :chapters, LL.Chapter, join_through: LL.ChaptersTags
    many_to_many :series, LL.Series, join_through: LL.SeriesTags

    timestamps()
  end
end
