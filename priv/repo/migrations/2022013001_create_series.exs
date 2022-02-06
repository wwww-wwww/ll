defmodule LL.Repo.Migrations.CreateSeries do
  use Ecto.Migration

  def change do
    create table(:series, primary_key: false) do
      add :id, :string, primary_key: true
      add :title, :string
      add :description, :string, size: 4096
      add :source, :string
      add :source_id, :string

      add :cover, :string

      timestamps()
    end
  end
end
