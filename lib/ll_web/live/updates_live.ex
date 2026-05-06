defmodule LLWeb.UpdatesLive do
  use LLWeb, :live_view

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Message, Series, Chapter}

  def title(), do: "Updates"

  def render(assigns) do
    ~H"""
    <h1>Updates</h1>

    <div class="messages">
      <button phx-click="clear-errors" style="align-self: start">
        Clear errors
      </button>
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
      LLWeb.Endpoint.subscribe("messages")
    end

    messages = Repo.all(Message)

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
            <.link navigate={~p"/library/#{@series.id}"}>{@series.title} ({@series.source.name})</.link>
            """
            |> Phoenix.HTML.Safe.to_iodata()
            |> IO.iodata_to_binary()

          [":chapter", id] ->
            chapter = Repo.get(Chapter, id)

            assigns = %{chapter: chapter}

            ~H"""
            <.link navigate={~p"/series/#{@chapter.series_id}/#{@chapter.id}"}>{@chapter.title}</.link>
            """
            |> Phoenix.HTML.Safe.to_iodata()
            |> IO.iodata_to_binary()

          _ ->
            group
        end

      String.replace(acc, match, replace)
    end)
    |> raw()
  end

  def handle_event("clear-errors", _params, socket) do
    from(m in Message, where: m.title == "Error")
    |> Repo.all()
    |> Enum.each(&Message.delete/1)

    {:noreply, socket}
  end

  def handle_event("delete", %{"id" => id}, socket) do
    Repo.get(Message, id) |> Message.delete()
    {:noreply, socket}
  end

  def handle_info(%{topic: "messages", event: "create", payload: message}, socket) do
    messages = socket.assigns.messages ++ [message]
    {:noreply, assign(socket, messages: messages)}
  end

  def handle_info(%{topic: "messages", event: "delete", payload: message}, socket) do
    messages = socket.assigns.messages |> Enum.reject(&(&1.id == message.id))
    {:noreply, assign(socket, messages: messages)}
  end
end
