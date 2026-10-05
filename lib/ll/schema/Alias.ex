defmodule LL.Alias do
  use Ecto.Schema

  schema "aliases" do
    belongs_to :series, LL.Series
    belongs_to :multi_series, LL.MultiSeries
    field :name, :string
  end
end
