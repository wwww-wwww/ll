defmodule LL.Repo.Migrations.CreateSource do
  use Ecto.Migration

  def change do
    create table(:sources) do
      add :source, :string
      add :type, :integer
      add :data_url, :string

      add :category_id, references(:categories, type: :string, on_delete: :delete_all)

      timestamps()
    end
  end
end
