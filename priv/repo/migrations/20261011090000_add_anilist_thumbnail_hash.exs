defmodule LL.Repo.Migrations.AddAnilistThumbnailHash do
  use Ecto.Migration

  def change do
    alter table(:anilist) do
      add :thumbnail_hash, :string
    end
  end
end
