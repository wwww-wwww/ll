defmodule LL.Repo.Migrations.CreateChapters do
  use Ecto.Migration

  def change do
    create table(:chapters, primary_key: false) do
      add :id, :string, primary_key: true
      add :number, :integer
      add :title, :string
      add :source, :string
      add :source_id, :string

      add :date, :date

      add :cover, :string
      add :path, :string
      add :files, {:array, :string}

      add :enc, :string
      add :enc_params, :string

      add :series_id, references(:series, type: :string, on_delete: :delete_all)

      timestamps()
    end
  end
end
