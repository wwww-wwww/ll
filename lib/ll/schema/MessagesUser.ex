defmodule LL.MessagesUser do
  use Ecto.Schema

  schema "messages_user" do
    belongs_to :message, LL.Message
    belongs_to :user, LL.User
  end
end
