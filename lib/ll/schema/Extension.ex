defmodule LL.Extension do
  use Ecto.Schema

  schema "extensions" do
    field :name, :string
    field :pkg, :string
    field :version, :string
    field :path, :string

    has_many :sources, LL.Source

    timestamps()
  end
end
