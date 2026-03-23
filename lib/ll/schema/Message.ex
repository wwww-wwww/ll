defmodule LL.Message do
  use Ecto.Schema

  alias LL.Repo

  schema "messages" do
    field :title, :string
    field :body, :string

    timestamps()
  end

  def create(title, body) do
    {:ok, message} =
      Ecto.Changeset.change(%__MODULE__{}, %{title: title, body: body})
      |> Repo.insert()

    LLWeb.Endpoint.broadcast("messages", "create", message)
  end

  def delete(message) do
    Repo.delete(message)
    LLWeb.Endpoint.broadcast("messages", "delete", message)
  end
end
