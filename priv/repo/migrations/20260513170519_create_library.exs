defmodule LL.Repo.Migrations.CreateLibrary do
  use Ecto.Migration

  def change do
    create table(:library) do
      add :name, :string

      add :user_id, references(:user, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:library, [:name, :user_id])

    create table(:library_series) do
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)
      add :library_id, references(:library, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:library_series, [:series_id, :library_id])

    create table(:library_multi) do
      add :multi_series_id, references(:multi_series, on_delete: :delete_all, on_update: :update_all)
      add :library_id, references(:library, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:library_multi, [:multi_series_id, :library_id])
  end
end
