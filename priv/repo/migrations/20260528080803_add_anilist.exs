defmodule LL.Repo.Migrations.AddAnilist do
  use Ecto.Migration

  def change do
    alter table(:series) do
      add :anilist_id, :integer
    end

    alter table(:multi_series) do
      add :anilist_id, :integer

      add :title, :text
      add :artist, :text
      add :author, :text
      add :description, :text
      add :genre, :text
      add :status, :integer

      add :thumbnail_path, :text
      add :details_updated, :utc_datetime
    end
  end
end
