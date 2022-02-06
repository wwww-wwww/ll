defmodule LL.ChaptersTags do
  use Ecto.Schema

  @primary_key false
  schema "chapters_tags" do
    belongs_to :chapter, LL.Chapter, type: :string
    belongs_to :tag, LL.Tag, type: :string

    timestamps()
  end

  def changeset(struct, params \\ %{}) do
    struct
    |> Ecto.Changeset.cast(params, [:chapter_id, :tag_id])
    |> Ecto.Changeset.validate_required([:chapter_id, :tag_id])
  end
end
