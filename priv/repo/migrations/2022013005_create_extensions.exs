defmodule LL.Repo.Migrations.CreateExtensions do
  use Ecto.Migration

  def change do
    create table(:extensions) do
      add :name, :string
      add :pkg, :string
      add :version, :string
      add :path, :text

      timestamps()
    end
  end
end
