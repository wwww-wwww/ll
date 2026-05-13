defmodule LL.Repo.Migrations.ChangeMulti do
  use Ecto.Migration

  def change do
    create table(:multi_series) do
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:multi_series, [:series_id])

    alter table(:series) do
      remove :multiseries_id
      add :multi_series_id, references(:multi_series, on_delete: :nilify_all)
    end

    create table(:multi_series_category) do
      add :multi_series_id, references(:multi_series, on_delete: :delete_all, on_update: :update_all)
      add :category_id, references(:category, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:multi_series_category, [:multi_series_id, :category_id])
  end
end
