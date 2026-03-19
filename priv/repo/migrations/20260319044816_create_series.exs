defmodule LL.Repo.Migrations.CreateSeries do
  use Ecto.Migration

  def change do
    create table(:series) do
      add :title, :text
      add :description, :text
      add :type, :string

      add :cover, :text

      add :source_id, references(:sources, on_delete: :nilify_all, on_update: :update_all)
      add :source_remote_id, :text

      timestamps()
    end
  end
end
