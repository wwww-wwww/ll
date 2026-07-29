defmodule LL.Repo.Migrations.AddUserLevel do
  use Ecto.Migration

  def change do
    alter table(:user) do
      add :level, :integer, default: 0
    end
  end
end
