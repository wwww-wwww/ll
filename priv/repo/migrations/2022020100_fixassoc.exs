defmodule LL.Repo.Migrations.AssocTags2 do
  use Ecto.Migration

  def change do
    create unique_index(:chapters_tags, [:chapter_id, :tag_id])

    create unique_index(:series_tags, [:series_id, :tag_id])
  end
end
