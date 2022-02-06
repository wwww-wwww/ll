defmodule LL.Repo.Migrations.CreateTags do
  use Ecto.Migration

  def change do
    create table(:tags, primary_key: false) do
      add :id, :string, primary_key: true
      add :name, :string
      add :type, :integer, default: 0

      add :inserted_at, :utc_datetime, default: fragment("now()")
      add :updated_at, :utc_datetime, default: fragment("now()")
    end
  end
end
