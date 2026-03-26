defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]
  alias LL.{Repo, Series, Chapter, ExtensionManager, MultiSeries}

  def title(), do: "Series"

  def render(assigns) do
    LLWeb.PageView.render("series.html", assigns)
  end

  def mount(:not_mounted_at_router, params, socket) do
    mount(params, nil, socket)
  end

  def mount(%{"series_id" => multi_id, "is_multi" => true}, _session, socket) do
    multi =
      Repo.get(MultiSeries, multi_id)
      |> Repo.preload(series: :source, children: :source)

    socket =
      socket
      |> assign(multi: multi)
      |> assign(is_multi: true)
      |> assign(page_title: multi.series.title)
      |> assign(series: multi.series)
      |> assign(chapters: [])

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
      |> Repo.preload([[source: :extension], :multiseries])

    source = series.source

    chapters = Chapter.list(series)

    multi =
      series.multiseries ||
        from(m in MultiSeries, where: m.series_id == ^series.id) |> Repo.one()

    socket =
      socket
      |> assign(multi: multi)
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

  def handle_event("refresh", _, socket) do
    ExtensionManager.series_details(socket.assigns.series)
    {:noreply, socket}
  end

  def handle_event("refresh_chapters", _, socket) do
    ExtensionManager.series_chapters(socket.assigns.series)
    {:noreply, socket}
  end

  def handle_event("library_add", _, socket) do
    {:ok, series} =
      Repo.transact(fn ->
        Repo.get(Series, socket.assigns.series.id)
        |> Ecto.Changeset.change(%{in_library: true})
        |> Repo.update()
      end)

    series =
      series
      |> Repo.preload(source: :extension)

    LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

    LLWeb.LibraryLive.update()

    LL.Message.create("Added {:library,#{series.id}} to library")

    {:noreply, socket}
  end

  def handle_event("library_remove", _, socket) do
    {:ok, series} =
      Repo.transact(fn ->
        Repo.get(Series, socket.assigns.series.id)
        |> Ecto.Changeset.change(%{in_library: false})
        |> Repo.update()
      end)

    series = Repo.preload(series, source: :extension)

    LLWeb.Endpoint.broadcast("series:#{series.id}", "update", series)

    LLWeb.LibraryLive.update()

    {:noreply, socket}
  end

  def handle_event("download_all", _, socket) do
    Repo.get(Series, socket.assigns.series.id)
    |> Repo.preload(:chapters)
    |> Map.get(:chapters)
    |> Enum.reject(&Chapter.downloaded(&1))
    |> Enum.each(&ExtensionManager.download_chapter(&1, socket.assigns.source))

    {:noreply, socket}
  end

  def handle_event("multi_create", _, socket) do
    %MultiSeries{}
    |> Ecto.Changeset.change(%{series_id: socket.assigns.series.id})
    |> Repo.insert()

    {:noreply, socket}
  end

  def handle_event("multi_get", _, socket) do
    multis = Repo.all(MultiSeries) |> Repo.preload(:series)
    {:noreply, assign(socket, multis: multis)}
  end

  def handle_event("multi_add", %{"id" => id}, socket) do
    Repo.transact(fn ->
      multi = Repo.get(MultiSeries, id)

      socket.assigns.series
      |> Repo.reload()
      |> Ecto.Changeset.change(%{multiseries_id: multi.id})
      |> Repo.update()
    end)

    {:noreply, socket}
  end

  def handle_info(%{topic: "series:" <> _id, event: "update", payload: series}, socket) do
    {:noreply, assign(socket, series: series)}
  end

  def handle_info(%{topic: "chapters:" <> _id, event: "update", payload: chapters}, socket) do
    {:noreply, assign(socket, chapters: chapters)}
  end
end
