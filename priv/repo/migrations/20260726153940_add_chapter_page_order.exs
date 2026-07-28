defmodule LL.Repo.Migrations.AddChapterPageOrder do
  use Ecto.Migration

  def change do
    alter table(:chapters) do
      add :page_order, {:array, :integer}
    end
  end
end
