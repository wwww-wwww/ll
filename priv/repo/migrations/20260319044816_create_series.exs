defmodule LL.Repo.Migrations.CreateSeries do
  use Ecto.Migration

  def change do
    create table(:series) do
      add :source_id, references(:sources, on_delete: :nilify_all, on_update: :update_all)
      add :url, :text

      add :title, :text
      add :artist, :text
      add :author, :text
      add :description, :text
      add :genre, :text
      add :status, :integer

      add :thumbnail_url, :text
      add :thumbnail_path, :text

      add :in_library, :boolean, default: false

      add :details_updated, :utc_datetime
      add :chapters_updated, :utc_datetime

      timestamps()
    end
  end
end
