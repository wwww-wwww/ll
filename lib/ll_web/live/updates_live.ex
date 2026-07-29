defmodule LLWeb.UpdatesLive do
  use LLWeb, :live_view

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Message, Series, Chapter, MessagesUser}
  alias LLWeb.Endpoint

  def title(), do: "Updates"

  def render(assigns) do
    ~H"""
    <h1>Updates</h1>

    <div class="messages">
      <div :for={e <- @messages |> Enum.sort_by(& &1.inserted_at, {:desc, NaiveDateTime})}>
        <div>
          <button phx-click="delete" phx-value-id={e.id} class="material-symbols-rounded">
            close
          </button>
          <span>{relative_time(e.inserted_at)}</span>
          <span>{replace_links(e.title)}</span>
        </div>
        <div :if={e.body != ""}>{replace_links(e.body)}</div>
      </div>
    </div>
    """
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      LLWeb.Endpoint.subscribe("messages:#{socket.assigns.current_scope.user.id}")
    end

    messages =
      socket.assigns.current_scope.user
      |> Repo.preload(:messages)
      |> Map.get(:messages)

    socket =
      socket
      |> assign(messages: messages)

    {:ok, socket}
  end

  def replace_links(body) do
    Regex.scan(~r/{(.+)?}/, body)
    |> Enum.reduce(body, fn [match, group], acc ->
      replace =
        group
        |> String.split(",")
        |> case do
          [":library", id] ->
            series = Repo.get(Series, id) |> Repo.preload(:source)

            assigns = %{series: series}

            ~H"""
            <.link navigate={~p"/series/#{@series.id}"}>
              {@series.title} ({@series.source.name})
            </.link>
            """
            |> Phoenix.HTML.Safe.to_iodata()
            |> IO.iodata_to_binary()

          [":chapter", id] ->
            case Repo.get(Chapter, id) do
              nil ->
                "nil"

              chapter ->
                assigns = %{chapter: chapter}

                ~H"""
                <.link navigate={~p"/series/#{@chapter.series_id}/#{@chapter.id}"}>{@chapter.title}</.link>
                """
                |> Phoenix.HTML.Safe.to_iodata()
                |> IO.iodata_to_binary()
            end

          _ ->
            group
        end

      String.replace(acc, match, replace)
    end)
    |> raw()
  end

  def handle_event("delete", %{"id" => id}, socket) do
    user_id = socket.assigns.current_scope.user.id

    Repo.transact(fn ->
      Repo.get_by(MessagesUser, message_id: id, user_id: user_id)
      |> case do
        nil ->
          {:ok, nil}

        message ->
          Repo.delete(message)
      end
    end)
    |> case do
      {:ok, %MessagesUser{} = message} ->
        Endpoint.broadcast("messages:#{user_id}", "delete", message)

        Endpoint.broadcast(
          "message_count:#{user_id}",
          "count",
          MessagesUser.count(socket.assigns.current_scope.user)
        )

      err ->
        nil
    end

    {:noreply, socket}
  end

  def handle_info(%{topic: "messages:" <> _user_id, event: "create", payload: message}, socket) do
    messages = socket.assigns.messages ++ [message]
    {:noreply, assign(socket, messages: messages)}
  end

  def handle_info(
        %{
          topic: "messages:" <> _user_id,
          event: "delete",
          payload: %MessagesUser{message_id: message_id}
        },
        socket
      ) do
    messages = socket.assigns.messages |> Enum.reject(&(&1.id == message_id))
    {:noreply, assign(socket, messages: messages)}
  end

  def handle_info(%{topic: "messages:" <> _user_id, event: "delete", payload: message}, socket) do
    messages = socket.assigns.messages |> Enum.reject(&(&1.id == message.id))
    {:noreply, assign(socket, messages: messages)}
  end
end
