defmodule LL.MessagesUser do
  use Ecto.Schema
  import Ecto.Query, only: [from: 2]

  schema "messages_user" do
    belongs_to :message, LL.Message
    belongs_to :user, LL.User
  end

  def count(%LL.User{id: user_id}) do
    from(m in LL.Message,
      join: u in __MODULE__,
      on: u.message_id == m.id,
      where: u.user_id == ^user_id
    )
    |> LL.Repo.aggregate(:count, :id)
  end
end
