defmodule LLWeb.UsersLive do
  use LLWeb, :live_view

  alias LL.{User, Repo}

  def title(), do: "Users"

  def render(assigns) do
    ~H"""
    <h1>Users</h1>

    <table>
      <tr :for={user <- @users |> Enum.sort_by(& &1.id)}>
        <td>{user.id}</td>
        <td>{user.username}</td>
        <td>{user.level}</td>
      </tr>
    </table>
    """
  end

  def mount(_, _, socket) do
    users = Repo.all(User)

    socket =
      socket
      |> assign(users: users)

    {:ok, socket}
  end
end
