defmodule LL.Library do
  use Ecto.Schema

  schema "library" do
    field :name, :string

    belongs_to :user, LL.User

    many_to_many :series, LL.Series, join_through: LL.LibrarySeries
    many_to_many :multi_series, LL.MultiSeries, join_through: LL.LibraryMulti
  end
end

defmodule LL.LibrarySeries do
  use Ecto.Schema

  schema "library_series" do
    belongs_to :series, LL.Series
    belongs_to :library, LL.Library
  end
end

defmodule LL.LibraryMulti do
  use Ecto.Schema

  schema "library_multi" do
    belongs_to :multi_series, LL.MultiSeries
    belongs_to :library, LL.Library
  end
end
