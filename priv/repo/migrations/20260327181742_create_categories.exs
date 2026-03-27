defmodule LL.Repo.Migrations.SeriesAddUpdate do
  use Ecto.Migration

  def change do
    create table(:category) do
      add :name, :string
      add :autoupdate, :boolean
    end

    create table(:series_category) do
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)
      add :category_id, references(:category, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:series_category, [:series_id, :category_id])
  end
end
