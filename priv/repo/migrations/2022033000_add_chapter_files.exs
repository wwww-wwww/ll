defmodule LL.Repo.Migrations.AddChapterOriginalFiles do
  use Ecto.Migration

  def change do
    alter table(:chapters) do
      add :original_files, {:array, :string}
      add :original_files_sizes, {:array, :integer}
    end
  end
end
