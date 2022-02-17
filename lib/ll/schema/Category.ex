defmodule LL.Category do
  use Ecto.Schema

  @primary_key false
  schema "categories" do
    field :id, :string, primary_key: true
    field :name, :string

    has_many :sources, LL.Source, references: :id

    timestamps()
  end
end
