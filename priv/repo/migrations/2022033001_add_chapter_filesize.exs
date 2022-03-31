defmodule LL.Repo.Migrations.AddChapterFilesize do
  use Ecto.Migration

  def change do
    alter table(:chapters) do
      add :filesize, :integer
    end
  end
end
