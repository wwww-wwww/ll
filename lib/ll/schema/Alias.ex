defmodule LL.Alias do
  use Ecto.Schema

  schema "alias" do
    belongs_to :anilist, LL.Anilist
    field :name, :string
  end
end
