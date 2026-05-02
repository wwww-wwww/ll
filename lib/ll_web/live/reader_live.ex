defmodule LLWeb.ReaderLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  alias LL.{Repo, Chapter}

  def render(assigns) do
    ~H"""
    <input type="checkbox" id="series_details_toggle" phx-update="ignore" />
    <div class="series_details">
      <div class="inner">
        <div class="details">
          <h1><.link navigate={~p"/series/#{@series.id}"}>{@series.title}</.link></h1>
          <.link target="_blank" href={Path.join(@source.base_url, @chapter.url)}>
            Read at source
          </.link>
        </div>

        <div id="chapterlist" class="chapterlist" phx-hook="chapterlist">
          <.live_component
            :for={c <- @chapters}
            module={LLWeb.ChapterComponent}
            id={LLWeb.ChapterComponent.id(c.id)}
            chapter={c}
            source={@source}
            selected={c.id == @chapter.id}
          />
        </div>
      </div>

      <div class="series_details_toggle">
        <label for="series_details_toggle" class="material-symbols-rounded"></label>
      </div>
    </div>

    <div
      id="reader"
      phx-hook="Reader"
      phx-update="ignore"
      data-files={Jason.encode!(@files)}
    >
      <svg style="position: fixed; visibility: hidden; transform: scale(0);">
        <filter id="noise2">
          <feTurbulence type="fractalNoise" baseFrequency="0.2" numOctaves="4" stitchTiles="stitch" />
          <feColorMatrix type="matrix" values="100 0 0 0 -75 0 100 0 0 -75 0 0 100 0 -75 0 0 0 0.3 0" />
        </filter>
      </svg>
      <div class="interstitial"></div>
      <canvas></canvas>
      <div class="info">
        <span class="page"></span>
        <span class="zoom"></span>
      </div>
    </div>
    """
  end

  def mount(%{"chapter_id" => chapter_id}, _session, socket) do
    Repo.get(Chapter, chapter_id)
    |> Repo.preload([:series, :source])
    |> case do
      nil ->
        socket =
          socket
          |> redirect(to: "/")
          |> put_flash(:error, "Chapter not found")

        {:ok, socket}

      chapter ->
        chapters = Chapter.list(chapter.series)

        series = chapter.series |> Map.put(:description, "")

        chapter = Map.put(chapter, :series, nil)

        files =
          Enum.with_index(chapter.files)
          |> Enum.map(fn {_, i} -> ~p"/page/#{chapter.id}/#{i + 1}" end)

        socket =
          socket
          |> assign(page_title: chapter.title)
          |> assign(series: series)
          |> assign(chapters: chapters)
          |> assign(chapter: chapter)
          |> assign(source: chapter.source)
          |> assign(files: files)

        {:ok, socket}
    end
  end

  def handle_params(params, _path, socket) do
    {:ok, socket} = mount(params, %{}, socket)
    send(self(), %{files: socket.assigns.files})
    {:noreply, socket}
  end

  def handle_info(params, socket) do
    socket = push_event(socket, "files", %{files: socket.assigns.files})
    {:noreply, socket}
  end
end
