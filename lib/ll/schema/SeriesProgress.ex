defmodule LL.SeriesProgress do
  use Ecto.Schema

  schema "series_progress" do
    belongs_to :user, LL.User
    belongs_to :anilist, LL.Anilist
    field :progress, :integer

    timestamps()
  end
end
