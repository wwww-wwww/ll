defmodule LL.MultiSeries do
  use Ecto.Schema

  schema "multiseries" do
    belongs_to :series, LL.Series

    has_many :children, LL.Series, foreign_key: :multiseries_id
  end
end
