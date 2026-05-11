defmodule LLWeb.CategoriesLive do
  use LLWeb, :live_view

  alias LL.{Repo, Category, Message}

  def title(), do: "Categories"

  def render(assigns) do
    ~H"""
    <h1>Categories</h1>

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
      <span :for={c <- @categories}>
        {c.name}
        <span class="check" phx-click="toggle_autoupdate" phx-value-id={c.id}>
          <input type="checkbox" id={"chk-autoupdate-#{c.id}"} checked={c.autoupdate} />
          <label for={"chk-autoupdate-#{c.id}"}>Auto update</label>
        </span>
        <button phx-click="delete" phx-value-id={c.id}>Delete</button>
      </span>
    </div>
    """
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("categories")
    end

    categories = Repo.all(Category) |> Enum.sort_by(& &1.id)

    socket =
      socket
      |> assign(form: to_form(%{"name" => ""}))
      |> assign(categories: categories)

    {:ok, socket}
  end

  def handle_info(%{topic: "categories", event: "update", payload: categories}, socket) do
    {:noreply, assign(socket, categories: categories)}
  end

  def handle_event("delete", %{"id" => id}, socket) do
    Repo.get(Category, id)
    |> Repo.delete()

    update()
    {:noreply, socket}
  end

  def handle_event("create", %{"name" => name}, socket) do
    name = String.trim(name)

    if String.length(name) > 0 do
      %Category{}
      |> Ecto.Changeset.change(%{name: name})
      |> Repo.insert()
      |> case do
        {:ok, _} -> update()
        err -> Message.error(err)
      end
    end

    {:noreply, socket}
  end

  def handle_event("toggle_autoupdate", %{"id" => id}, socket) do
    Repo.transact(fn ->
      category = Repo.get(Category, id)

      Ecto.Changeset.change(category, %{autoupdate: not (category.autoupdate || false)})
      |> Repo.update()
    end)
    |> case do
      {:ok, _} -> update()
      err -> Message.error(err)
    end

    {:noreply, socket}
  end

  def update() do
    categories = Repo.all(Category) |> Enum.sort_by(& &1.id)
    Endpoint.broadcast("categories", "update", categories)
  end
end
