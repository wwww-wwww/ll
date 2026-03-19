defmodule LL.Source do
  use Ecto.Schema

  schema "sources" do
    field :name, :string
    field :lang, :string

    belongs_to :extension, LL.Extension

    timestamps()
  end
end
