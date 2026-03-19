defmodule LL.Source do
  use Ecto.Schema

  schema "sources" do
    field :source_id, :integer
    field :name, :string
    field :lang, :string

    belongs_to :extension, LL.Extension

    timestamps()
  end
end
