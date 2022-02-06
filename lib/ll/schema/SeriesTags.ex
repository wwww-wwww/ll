defmodule LL.SeriesTags do
  use Ecto.Schema

  @primary_key false
  schema "series_tags" do
    belongs_to :series, LL.Series, type: :string
    belongs_to :tag, LL.Tag, type: :string

    timestamps()
  end

  def changeset(struct, params \\ %{}) do
    struct
    |> Ecto.Changeset.cast(params, [:series_id, :tag_id])
    |> Ecto.Changeset.validate_required([:series_id, :tag_id])
  end
end
