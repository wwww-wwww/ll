defmodule LL.Repo.Migrations.CreateMultiCategory do
  use Ecto.Migration

  def change do
    create table(:multiseries_category) do
      add :multiseries_id, references(:multiseries, on_delete: :delete_all, on_update: :update_all)
      add :category_id, references(:category, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:multiseries_category, [:multiseries_id, :category_id])
  end
end
