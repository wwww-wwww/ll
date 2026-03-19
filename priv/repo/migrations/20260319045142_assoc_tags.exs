defmodule LL.Repo.Migrations.AssocTags do
  use Ecto.Migration

  def change do
    create table(:chapters_tags) do
      add :chapter_id, references(:chapters, on_delete: :delete_all)
      add :tag_id, references(:tags, type: :string, on_delete: :delete_all)

      timestamps()
    end

    create unique_index(:chapters_tags, [:chapter_id, :tag_id])

    create table(:series_tags) do
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)
      add :tag_id, references(:tags, type: :string, on_delete: :delete_all)

      timestamps()
    end

    create unique_index(:series_tags, [:series_id, :tag_id])
  end
end
