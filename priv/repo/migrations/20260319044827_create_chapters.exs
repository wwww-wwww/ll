defmodule LL.Repo.Migrations.CreateChapters do
  use Ecto.Migration

  def change do
    create table(:chapters) do
      add :source_id, references(:sources, on_delete: :nilify_all, on_update: :update_all)
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)
      add :url, :text

      add :title, :text
      add :number, :float
      add :date, :utc_datetime
      add :scanlator, :string

      add :files, {:array, :text}

      timestamps()
    end
  end
end
