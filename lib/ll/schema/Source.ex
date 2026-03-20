defmodule LL.Source do
  use Ecto.Schema

  schema "sources" do
    belongs_to :extension, LL.Extension
    field :source_id, :integer
    field :name, :string
    field :lang, :string
    field :base_url, :string

    timestamps()
  end
end
