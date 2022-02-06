defmodule LL.Repo.Migrations.CreateSource do
  use Ecto.Migration

  def change do
    create table(:sources) do
      add :source, :string
      add :type, :integer
      add :data_url, :string

      timestamps()
    end
  end
end
