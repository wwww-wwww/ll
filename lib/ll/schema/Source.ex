defmodule LL.Source do
  use Ecto.Schema

  schema "sources" do
    field :source, :string
    field :type, :integer
    field :data_url, :string

    timestamps()
  end
end
