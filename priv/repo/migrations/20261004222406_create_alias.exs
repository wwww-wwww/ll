defmodule LL.Repo.Migrations.CreateAlias do
  use Ecto.Migration

  def change do
    create table(:aliases) do
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)
      add :multi_series_id, references(:multi_series, on_delete: :delete_all, on_update: :update_all)
      add :name, :string
    end
  end
end
