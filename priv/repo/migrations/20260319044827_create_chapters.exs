defmodule LL.Repo.Migrations.CreateChapters do
  use Ecto.Migration

  def change do
    create table(:chapters) do
      add :number, :integer
      add :title, :text
      add :date, :date

      add :cover, :text
      add :files, {:array, :text}

      add :source_id, references(:sources, on_delete: :nilify_all, on_update: :update_all)
      add :source_remote_id, :text

      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)

      timestamps()
    end
  end
end
