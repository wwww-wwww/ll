defmodule LL.Repo.Migrations.AddUsersAnilist do
  use Ecto.Migration

  def change do
    alter table(:user) do
      add :anilist_key, :text
    end
  end
end
