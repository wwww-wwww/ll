defmodule LL.Repo.Migrations.AddChapterOriginalFiles do
  use Ecto.Migration

  def change do
    alter table(:chapters) do
      modify :cover, :text
      modify :files, {:array, :text}
      modify :original_files, {:array, :text}
    end
  end
end
