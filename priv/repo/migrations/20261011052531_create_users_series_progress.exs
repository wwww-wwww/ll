defmodule LL.Repo.Migrations.CreateUsersSeriesProgress do
  use Ecto.Migration

  def change do
    create table(:series_progress) do
      add :user_id, references(:user, on_delete: :delete_all, on_update: :update_all)
      add :anilist_id, references(:anilist, on_delete: :delete_all, on_update: :update_all)
      add :progress, :integer, default: 0

      timestamps()
    end
  end
end
