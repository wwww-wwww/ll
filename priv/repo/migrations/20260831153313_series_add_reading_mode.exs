defmodule LL.Repo.Migrations.SeriesAddReadingMode do
  use Ecto.Migration

  def change do
    alter table(:series) do
      add :reading_mode, :string
    end

    alter table(:multi_series) do
      add :reading_mode, :string
    end
  end
end
