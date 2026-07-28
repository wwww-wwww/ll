defmodule LL.Message do
  use Ecto.Schema

  require Logger
  alias LL.Repo

  import Ecto.Query, only: [from: 2]

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
    message
  end

  def delete(message) do
    Repo.delete(message)

    count = Repo.aggregate(__MODULE__, :count, :id)
    LLWeb.Endpoint.broadcast("messages", "delete", message)
    LLWeb.Endpoint.broadcast("message_count", "count", count)
  end

  def error(message) do
    create("Error", inspect(message))
  end

  def new_chapter(series, chapter) do
    title = "{:library,#{series.id}}"
    body = "New chapter {:chapter,#{chapter.id}}"

    create(title, body)

    from(l in LL.Library,
      join: ls in LL.LibrarySeries,
      on: ls.library_id == l.id,
      where: ls.series == ^series.id
    )
    |> Repo.all()
    |> IO.inspect()
  end
end
