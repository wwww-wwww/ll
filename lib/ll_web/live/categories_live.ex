defmodule LLWeb.CategoriesLive do
  use LLWeb, :live_view

  alias LL.{Repo, Category, Message}

  def title(), do: "Categories"

  def render(assigns) do
    LLWeb.PageView.render("categories.html", assigns)
  end

  def mount(_, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("categories")
    end

    form = to_form(%{"name" => ""})
    categories = Repo.all(Category)

    socket =
      socket
      |> assign(form: form)
      |> assign(categories: categories)

    {:ok, socket}
  end

  def handle_info(%{topic: "categories", event: "update", payload: categories}, socket) do
    {:noreply, assign(socket, categories: categories)}
  end

  def handle_event("delete", %{"id" => id}, socket) do
    Repo.get(Category, id)
    |> Repo.delete()

    categories = Repo.all(Category)
    Endpoint.broadcast("categories", "update", categories)
    {:noreply, socket}
  end

  def handle_event("create", %{"name" => name}, socket) do
    name = String.trim(name)

    if String.length(name) > 0 do
      %Category{}
      |> Ecto.Changeset.change(%{name: name})
      |> Repo.insert()
      |> case do
        {:ok, _} ->
          categories = Repo.all(Category)
          Endpoint.broadcast("categories", "update", categories)

        err ->
          Message.error(err)
      end
    end

    {:noreply, socket}
  end
end
