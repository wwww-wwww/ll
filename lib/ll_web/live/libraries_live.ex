defmodule LLWeb.LibrariesLive do
  use LLWeb, :live_view
  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Library}

  def title(), do: "Libraries"

  def render(assigns) do
    ~H"""
    <h1>Libraries</h1>

    <.form for={@form} phx-submit="create">
      <div>
        <input
          type="text"
          id={@form[:name].id}
          name={@form[:name].name}
          value={@form[:name].value}
        />

        <input type="submit" value="Create" />
      </div>
    </.form>

    <div>
      <span :for={c <- @libraries}>
        {c.name}
        <button phx-click="delete" phx-value-id={c.id}>Delete</button>
      </span>
    </div>
    """
  end

  def mount(_, _session, socket) do
    socket =
      socket
      |> assign(form: to_form(%{"name" => ""}))
      |> assign(libraries: get_libraries(socket))

    {:ok, socket}
  end

  def handle_event("delete", %{"id" => id}, socket) do
    user_id = socket.assigns.current_scope.user.id

    Repo.get_by(Library, id: id, user_id: user_id)
    |> case do
      nil ->
        {:noreply, socket}

      library ->
        Repo.delete(library)
        {:noreply, assign(socket, libraries: get_libraries(socket))}
    end
  end

  def handle_event("create", %{"name" => name}, socket) do
    name = String.trim(name)

    if String.length(name) > 0 do
      %Library{user_id: socket.assigns.current_scope.user.id}
      |> Ecto.Changeset.change(%{name: name})
      |> Repo.insert()
      |> case do
        {:ok, _} -> {:noreply, assign(socket, libraries: get_libraries(socket))}
        err -> {:noreply, put_flash(socket, :error, inspect(err))}
      end
    else
      {:noreply, socket}
    end
  end

  def get_libraries(socket) do
    user = socket.assigns.current_scope.user

    from(l in Library, where: l.user_id == ^user.id)
    |> Repo.all()
    |> Enum.sort_by(& &1.id)
  end
end
