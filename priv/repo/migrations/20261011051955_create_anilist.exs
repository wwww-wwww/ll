defmodule LL.Repo.Migrations.CreateAnilist do
  use Ecto.Migration

  def up do
    create table(:anilist) do
      add :title, :text
      add :artist, :text
      add :author, :text
      add :description, :text
      add :genre, :text
      add :status, :integer
      add :thumbnail_path, :text

      timestamps()
    end

    create table(:alias) do
      add :anilist_id, references(:anilist, on_delete: :delete_all, on_update: :update_all)
      add :name, :string
    end

    alter table(:series) do
      remove :anilist_id
      add :anilist_id, references(:anilist, on_delete: :delete_all, on_update: :update_all)
    end
  end

  def down do
    alter table(:series) do
      remove :anilist_id
      add :anilist_id, :integer
    end

    drop table(:alias)
    drop table(:anilist)
  end
end
