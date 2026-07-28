defmodule LL.Repo.Migrations.CreateMessagesUsers do
  use Ecto.Migration

  def change do
    create table(:messages_user) do
      add :message_id, references(:messages, on_delete: :delete_all, on_update: :update_all)
      add :user_id, references(:user, on_delete: :delete_all, on_update: :update_all)
    end

    create unique_index(:messages_user, [:message_id, :user_id])
  end
end
