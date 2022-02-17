defmodule LL.Source do
  use Ecto.Schema

  schema "sources" do
    field :source, :string
    field :type, :integer
    field :data_url, :string
    belongs_to :category, LL.Category, type: :string, on_replace: :delete

    timestamps()
  end
end
