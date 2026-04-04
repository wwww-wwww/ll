defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  require Logger

  alias LL.{
    Repo,
    Series,
    Chapter,
    ExtensionManager,
    MultiSeries,
    Message,
    Category,
    SeriesCategory
  }

  def title(), do: "Series"

  def render(assigns) do
    LLWeb.PageView.render("series.html", assigns)
  end

  def mount(:not_mounted_at_router, params, socket) do
    mount(params, nil, socket)
  end

  def mount(%{"series_id" => multi_id, "is_multi" => true}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("multi:#{multi_id}")
    end

    multi =
      Repo.get(MultiSeries, multi_id)
      |> Repo.preload(series: :source, children: :source)

    chapters = MultiSeries.get_chapters(multi)

    socket =
      socket
      |> assign(multi: multi)
      |> assign(is_multi: true)
      |> assign(page_title: multi.series.title)
      |> assign(series: multi.series)
      |> assign(chapters: chapters)

    {:ok, socket}
  end

  def mount(%{"series_id" => "m" <> multi_id}, session, socket) do
    mount(%{"series_id" => multi_id, "is_multi" => true}, session, socket)
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("series:#{series_id}")
      Endpoint.subscribe("chapters:#{series_id}")
    end

    series =
      Repo.get(Series, series_id)
      |> Repo.preload([[source: :extension], [multiseries: :series], :categories])

    source = series.source

    chapters = Chapter.list(series)

    multi = Repo.get_by(MultiSeries, series_id: series.id)

    socket =
      socket
      |> assign(multi: multi)
      |> assign(is_multi: false)
      |> assign(page_title: series.title)
      |> assign(series: series)
      |> assign(source: source)
      |> assign(chapters: chapters)

    if series.details_updated == nil do
      ExtensionManager.series_details(series)
    end

    if series.chapters_updated == nil do
      ExtensionManager.series_chapters(series)
    end

    {:ok, socket}
  end

  def update(%LL.Series{} = series) do
    series = LL.Repo.preload(series, [[multiseries: :series], :categories])

    Endpoint.broadcast("series:#{series.id}", "update", series)

    if multi = Repo.get_by(MultiSeries, series_id: series.id) do
      update(multi)
    end
  end

  def update(%LL.MultiSeries{} = multi) do
    multi = LL.Repo.preload(multi, series: [:source, :chapters], children: [:source, :chapters])
    Endpoint.broadcast("multi:#{multi.id}", "update", multi)
  end

  def handle_event("refresh_details", _, socket) do
    ExtensionManager.series_details(socket.assigns.series)
    {:noreply, socket}
  end

  def handle_event("refresh_chapters", _, socket) do
    ExtensionManager.series_chapters(socket.assigns.series)

    if socket.assigns.is_multi do
      socket.assigns.multi.children |> Enum.each(&ExtensionManager.series_chapters/1)
    end

    {:noreply, socket}
  end

  def handle_event("library_add", _, socket) do
    Repo.transact(fn ->
      Repo.get(Series, socket.assigns.series.id)
      |> Ecto.Changeset.change(%{in_library: true})
      |> Repo.update()
    end)
    |> case do
      {:ok, series} ->
        LL.Message.create("Added {:library,#{series.id}} to library")
        update(series)
        LLWeb.LibraryLive.update()

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("library_remove", _, socket) do
    Repo.transact(fn ->
      Repo.get(Series, socket.assigns.series.id)
      |> Ecto.Changeset.change(%{in_library: false})
      |> Repo.update()
    end)
    |> case do
      {:ok, series} ->
        LL.Message.create("Removed {:library,#{series.id}} from library")
        update(series)
        LLWeb.LibraryLive.update()

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("download_all", _, socket) do
    Repo.get(Series, socket.assigns.series.id)
    |> Repo.preload(:chapters)
    |> Map.get(:chapters)
    |> Enum.reject(&Chapter.downloaded?(&1))
    |> Enum.each(&ExtensionManager.download_chapter(&1, socket.assigns.source))

    {:noreply, socket}
  end

  def handle_event("multi_create", _, socket) do
    %MultiSeries{}
    |> Ecto.Changeset.change(%{series_id: socket.assigns.series.id})
    |> Repo.insert()
    |> case do
      {:ok, multi} ->
        Endpoint.broadcast("series:#{socket.assigns.series.id}", "multi", multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_get", _, socket) do
    multis = Repo.all(MultiSeries) |> Repo.preload(:series)
    {:noreply, assign(socket, multis: multis)}
  end

  def handle_event("multi_add", %{"id" => id}, socket) do
    Repo.transact(fn ->
      multi = Repo.get(MultiSeries, id)

      series =
        socket.assigns.series
        |> Repo.reload()
        |> Ecto.Changeset.change(%{multiseries_id: multi.id})
        |> Repo.update!()

      {:ok, {multi, series}}
    end)
    |> case do
      {:ok, {multi, series}} ->
        update(series)
        update(multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_set_primary", %{"id" => id}, socket) do
    Repo.transact(fn ->
      multi =
        socket.assigns.multi
        |> Repo.reload()
        |> Repo.preload(:series)

      multi.series
      |> Ecto.Changeset.change(%{multiseries_id: multi.id})
      |> Repo.update!()

      {:ok, series} =
        Repo.get(Series, id)
        |> Ecto.Changeset.change(%{multiseries_id: nil})
        |> Repo.update()

      multi
      |> Ecto.Changeset.change(%{series_id: series.id})
      |> Repo.update()
    end)
    |> case do
      {:ok, multi} ->
        update(multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_remove", %{"id" => id}, socket) do
    Repo.transact(fn ->
      series =
        Repo.get(Series, id)
        |> Ecto.Changeset.change(%{multiseries_id: nil})
        |> Repo.update!()

      multi = Repo.reload(socket.assigns[:multi]) || Repo.get(MultiSeries, series.multiseries_id)

      {:ok, {multi, series}}
    end)
    |> case do
      {:ok, {multi, series}} ->
        update(series)
        update(multi)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("multi_delete", _, socket) do
    socket.assigns.multi
    |> Repo.delete()
    |> case do
      {:ok, _} ->
        Endpoint.broadcast("series:#{socket.assigns.series.id}", "multi", nil)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("category_get", _, socket) do
    categories = Repo.all(Category)
    {:noreply, assign(socket, categories: categories)}
  end

  def handle_event("category_add", %{"id" => id}, socket) do
    category = Repo.get(Category, id)

    Repo.transact(fn ->
      %SeriesCategory{}
      |> Ecto.Changeset.change(%{})
      |> Ecto.Changeset.put_assoc(:series, socket.assigns.series)
      |> Ecto.Changeset.put_assoc(:category, category)
      |> Repo.insert!()

      series = Repo.reload(socket.assigns.series)
      {:ok, series}
    end)
    |> case do
      {:ok, series} ->
        update(series)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_event("category_remove", %{"id" => id}, socket) do
    Repo.transact(fn ->
      Repo.get_by(SeriesCategory, series_id: socket.assigns.series.id, category_id: id)
      |> Repo.delete!()

      series = Repo.reload(socket.assigns.series)
      {:ok, series}
    end)
    |> case do
      {:ok, series} ->
        update(series)

      err ->
        Message.error(err)
    end

    {:noreply, socket}
  end

  def handle_info(%{topic: "series:" <> _id, event: "update", payload: series}, socket) do
    {:noreply, assign(socket, series: series)}
  end

  def handle_info(%{topic: "series:" <> _id, event: "multi", payload: multi}, socket) do
    {:noreply, assign(socket, multi: multi)}
  end

  def handle_info(%{topic: "chapters:" <> _id, event: "update", payload: chapters}, socket) do
    {:noreply, assign(socket, chapters: chapters)}
  end

  def handle_info(%{topic: "multi:" <> _id, event: "update", payload: multi}, socket) do
    chapters = MultiSeries.get_chapters(multi)

    socket =
      socket
      |> assign(multi: multi)
      |> assign(page_title: multi.series.title)
      |> assign(series: multi.series)
      |> assign(chapters: chapters)

    {:noreply, assign(socket, multi: multi)}
  end
end
