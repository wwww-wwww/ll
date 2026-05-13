defmodule LL.Category do
  use Ecto.Schema

  schema "category" do
    field :name, :string
    field :autoupdate, :boolean

    many_to_many :series, LL.Series, join_through: LL.SeriesCategory
    many_to_many :multi_series, LL.MultiSeries, join_through: LL.MultiSeriesCategory
  end
end

defmodule LL.SeriesCategory do
  use Ecto.Schema

  schema "series_category" do
    belongs_to :series, LL.Series
    belongs_to :category, LL.Category
  end
end

defmodule LL.MultiSeriesCategory do
  use Ecto.Schema

  schema "multi_series_category" do
    belongs_to :multi_series, LL.MultiSeries
    belongs_to :category, LL.Category
  end
end
