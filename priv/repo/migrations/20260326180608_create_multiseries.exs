defmodule LL.Repo.Migrations.CreateMultiseries do
  use Ecto.Migration

  def change do
    create table(:multiseries) do
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:multiseries, [:series_id])

    alter table(:series) do
      add :multiseries_id, references(:multiseries, on_delete: :nilify_all)
      add :priority, :integer
    end

  end
end
