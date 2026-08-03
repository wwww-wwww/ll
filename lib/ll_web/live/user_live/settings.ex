defmodule LLWeb.UserLive.Settings do
  use LLWeb, :live_view
  import Ecto.Query, only: [from: 2]

  alias LL.{Accounts, Repo, Library}

  def title(), do: "Settings"

  @impl true
  def render(assigns) do
    ~H"""
    <h1>{@user.id}:{@user.username}</h1>

    <h1>Libraries</h1>

    <.form for={@library_form} phx-submit="library-create">
      <div>
        <input
          type="text"
          id={@library_form[:name].id}
          name={@library_form[:name].name}
          value={@library_form[:name].value}
        />

        <input type="submit" value="Create" />
      </div>
    </.form>

    <table>
      <tr :for={c <- @libraries |> Enum.sort_by(& &1.id)}>
        <td><button phx-click="library-delete" phx-value-id={c.id}>Delete</button></td>
        <td>{c.name}</td>
      </tr>
    </table>

    <h2>Password</h2>
    <.form
      for={@password_form}
      id="password_form"
      action={~p"/user/update-password"}
      method="post"
      phx-change="validate_password"
      phx-submit="update_password"
      phx-trigger-action={@trigger_submit}
    >
      <input
        name={@password_form[:username].name}
        type="hidden"
        id="hidden_user_username"
        spellcheck="false"
        value={@current_username}
      />
      <.input
        field={@password_form[:password]}
        type="password"
        label="New password"
        autocomplete="new-password"
        spellcheck="false"
        required
      />
      <.input
        field={@password_form[:password_confirmation]}
        type="password"
        label="Confirm new password"
        autocomplete="new-password"
        spellcheck="false"
      />
      <.button variant="primary" phx-disable-with="Saving...">
        Save Password
      </.button>
    </.form>
    """
  end

  @impl true
  def mount(_params, _session, socket) do
    user = socket.assigns.current_scope.user
    password_changeset = Accounts.change_user_password(user, %{}, hash_password: false)

    socket =
      socket
      |> assign(library_form: to_form(%{"name" => ""}))
      |> assign(libraries: get_libraries(socket))
      |> assign(user: user)
      |> assign(current_username: user.username)
      |> assign(password_form: to_form(password_changeset))
      |> assign(trigger_submit: false)

    {:ok, socket}
  end

  @impl true
  def handle_event("validate_password", params, socket) do
    %{"user" => user_params} = params

    password_form =
      socket.assigns.current_scope.user
      |> Accounts.change_user_password(user_params, hash_password: false)
      |> Map.put(:action, :validate)
      |> to_form()

    {:noreply, assign(socket, password_form: password_form)}
  end

  @impl true
  def handle_event("update_password", params, socket) do
    %{"user" => user_params} = params
    user = socket.assigns.current_scope.user

    case Accounts.change_user_password(user, user_params) do
      %{valid?: true} = changeset ->
        {:noreply, assign(socket, trigger_submit: true, password_form: to_form(changeset))}

      changeset ->
        {:noreply, assign(socket, password_form: to_form(changeset, action: :insert))}
    end
  end

  def handle_event("library-delete", %{"id" => id}, socket) do
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

  def handle_event("library-create", %{"name" => name}, socket) do
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
