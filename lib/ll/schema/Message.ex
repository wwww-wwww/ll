defmodule LL.Message do
  use Ecto.Schema

  alias LL.Repo

  schema "messages" do
    field :title, :string
    field :body, :string

    timestamps()
  end

  def create(title, body \\ "") do
    {:ok, message} =
      Ecto.Changeset.change(%__MODULE__{}, %{title: title, body: body})
      |> Repo.insert()

    count = Repo.aggregate(__MODULE__, :count, :id)

    LLWeb.Endpoint.broadcast("messages", "create", message)
    LLWeb.Endpoint.broadcast("message_count", "count", count)
  end

  def delete(message) do
    Repo.delete(message)

    count = Repo.aggregate(__MODULE__, :count, :id)
    LLWeb.Endpoint.broadcast("messages", "delete", message)
    LLWeb.Endpoint.broadcast("message_count", "count", count)
  end
end
