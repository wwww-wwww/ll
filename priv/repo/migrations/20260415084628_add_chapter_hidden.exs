defmodule LL.Repo.Migrations.AddChapterHidden do
  use Ecto.Migration

  def change do
    alter table(:chapters) do
      add :hidden, :boolean
    end
  end
end
