defmodule LL.Category do
  use Ecto.Schema

  alias LL.{Repo, Tag}

  @primary_key false
  schema "categories" do
    field :id, :string, primary_key: true
    field :name, :string

    has_many :sources, LL.Source, references: :id

    timestamps()
  end

  def tag(%__MODULE__{id: id, name: name} = category) do
    Repo.insert_all(
      Tag,
      [
        %{
          id: "category_#{id}",
          name: name,
          type: 4
        }
      ],
      on_conflict: :nothing
    )

    Repo.get(Tag, "category_#{id}")
  end

  def from_tag(%Tag{id: "category_" <> tag_id} = tag) do
    Repo.get_by(__MODULE__, id: tag_id)
  end
end
