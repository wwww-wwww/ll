defmodule LL.Message do
  use Ecto.Schema

  require Logger
  alias LL.{Repo, Series, MultiSeries}

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

    LLWeb.Endpoint.broadcast("messages", "create", message)
    message
  end

  def error(message) do
    create("Error", inspect(message))
  end

  defp libraries(%Series{id: id}) do
    from(l in LL.Library,
      join: ls in LL.LibrarySeries,
      on: ls.library_id == l.id,
      where: ls.series_id == ^id and not is_nil(l.user_id)
    )
    |> Repo.all()
  end

  defp libraries(%MultiSeries{id: id}) do
    from(l in LL.Library,
      join: ls in LL.LibraryMulti,
      on: ls.library_id == l.id,
      where: ls.multi_series_id == ^id and not is_nil(l.user_id)
    )
    |> Repo.all()
  end

  def new_chapter(series, chapter) do
    series = Repo.preload(series, :multi_series) |> Map.get(:multi_series) || series

    type =
      case series do
        %MultiSeries{} -> :multi
        %Series{} -> :series
      end

    title = "{#{type},#{series.id}}"
    body = "New chapter {:chapter,#{chapter.id}}"

    Repo.transact(fn ->
      message = create(title, body)

      entries =
        libraries(series)
        |> Enum.with_index()
        |> Enum.map(fn {library, i} ->
          %{message_id: message.id, user_id: library.user_id}
        end)

      {count, res} = Repo.insert_all(LL.MessagesUser, entries, returning: true)

      {:ok, {message, res}}
    end)
    |> case do
      {:ok, {message, messages}} ->
        Enum.each(messages, fn %{user_id: user_id} ->
          LLWeb.Endpoint.broadcast("messages:#{user_id}", "create", message)
          LLWeb.Endpoint.broadcast("message_count:#{user_id}", "new", %{})
        end)

      err ->
        error(err)
    end
  end
end
