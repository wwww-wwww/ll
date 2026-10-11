defmodule LL.Repo.Migrations.DropAliases do
  use Ecto.Migration

  def up do
    drop table(:aliases)
  end

  def down do
    create table(:aliases) do
      add :series_id, references(:series, on_delete: :delete_all, on_update: :update_all)

      add :multi_series_id,
          references(:multi_series, on_delete: :delete_all, on_update: :update_all)

      add :name, :string
    end
  end
end
