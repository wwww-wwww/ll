defmodule LLWeb.SeriesLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  import Ecto.Query, only: [from: 2]
  alias LL.{Repo, Series, Chapter}

  def title(), do: "Series"

  def render(assigns) do
    LLWeb.PageView.render("series.html", assigns)
  end

  def mount(%{"series_id" => series_id}, _session, socket) do
    if connected?(socket) do
      Endpoint.subscribe("series:#{series_id}")
      Endpoint.subscribe("chapters:#{series_id}")
    end

    series =
      Repo.get(Series, series_id)
      |> Repo.preload(source: :extension)

    source = series.source
    tags = series.tags

    chapters =
      from(c in Chapter, where: c.series_id == ^series.id)
      |> Repo.all()

    socket =
      socket
      |> assign(series: series)
      |> assign(source: source)
      |> assign(chapters: chapters)
      |> assign(page_title: series.title)

    if series.details_updated == nil do
      LL.ExtensionManager.series_details(series)
    end

    if series.chapters_updated == nil do
      LL.ExtensionManager.series_chapters(series)
    end

    {:ok, socket}
  end
end
