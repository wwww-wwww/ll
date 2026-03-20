defmodule LL.Repo.Migrations.CreateSources do
  use Ecto.Migration

  def change do
    create table(:sources) do
      add :source_id, :identity
      add :name, :string
      add :lang, :string
      add :base_url, :text

      add :extension_id, references(:extensions, on_delete: :delete_all, on_update: :update_all)

      timestamps()
    end
  end
end
