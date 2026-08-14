defmodule LLWeb.ReaderLive do
  use LLWeb, :live_view
  use LLWeb.ChapterComponent

  alias LL.{Repo, Chapter, MultiSeries}

  def render(assigns) do
    ~H"""
    <input type="checkbox" id="series_details_toggle" phx-update="ignore" />
    <div class="series_details">
      <div class="inner">
        <div class="details">
          <h2>
            <%= if assigns[:multi] do %>
              <.link navigate={~p"/multi/#{@multi.id}"}>{@multi.series.title} (Multi)</.link>
            <% else %>
              <.link navigate={~p"/series/#{@series.id}"}>{@series.title}</.link>
            <% end %>
          </h2>
        </div>

        <div :if={LL.User.mod?(@current_scope)} class="details">
          <button :if={is_nil(@files.order)} phx-click="order-get">detect</button>
          <div :if={not is_nil(@files.order)}>
            <form phx-submit="order-save">
              <textarea name="order">{inspect(@files.order)}</textarea>
              <button>Save</button>
            </form>
            <div id="current_page"></div>
            <button phx-click="order-reset" phx-value-n="0">no dropped pages 0</button>
            <button phx-click="order-reset" phx-value-n="1">no dropped pages 1</button>
            <table>
              <tr :for={{o, i} <- @files.order |> Enum.with_index()} class="order-page" index={i}>
                <td>
                  <button phx-click="order-set" phx-value-index={i} phx-value-n="0" disabled={o == 0}>
                    0
                  </button>
                </td>
                <td>
                  <button phx-click="order-set" phx-value-index={i} phx-value-n="1" disabled={o == 1}>
                    1
                  </button>
                </td>
                <td>
                  <button phx-click="order-set" phx-value-index={i} phx-value-n="2" disabled={o == 2}>
                    2
                  </button>
                </td>
                <td>
                  <button phx-click="order-alt" phx-value-index={i} phx-value-n="0">alt</button>
                </td>
                <td>
                  <button phx-click="order-alt" phx-value-index={i} phx-value-n="1">alt 1</button>
                </td>
                <td><button phx-click={JS.push("move")} phx-value-index={i}>move</button></td>
              </tr>
            </table>
          </div>
        </div>

        <div id="chapterlist" class="chapterlist" phx-hook="chapterlist">
          <%= if assigns[:multi] do %>
            <.live_component
              :for={{s, c} <- @chapters}
              :if={c.hidden != true}
              module={LLWeb.ChapterComponent}
              id={LLWeb.ChapterComponent.id(c.id)}
              href={~p"/multi/#{@multi.id}/#{c.id}"}
              chapter={c}
              source={s.source}
              show_source={true}
              selected={c.id == @chapter.id}
            />
          <% else %>
            <.live_component
              :for={c <- @chapters}
              :if={c.hidden != true}
              module={LLWeb.ChapterComponent}
              id={LLWeb.ChapterComponent.id(c.id)}
              href={~p"/series/#{c.series_id}/#{c.id}"}
              chapter={c}
              source={@source}
              selected={c.id == @chapter.id}
            />
          <% end %>
        </div>
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
      <div class="info">
        <span class="page"></span>
        <span class="zoom"></span>
        <span class="mipmaplevel"></span>
        <div class="log"></div>
      </div>
    </div>
    """
  end

  def mount(%{"multi_id" => multi_id, "chapter_id" => chapter_id}, session, socket) do
    multi = Repo.get(MultiSeries, multi_id) |> Repo.preload(:series)

    chapters = MultiSeries.get_chapters(multi)

    socket =
      socket
      |> assign(multi: multi)
      |> assign(chapters: chapters)

    mount(%{"chapter_id" => chapter_id}, session, socket)
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
        series = Map.put(chapter.series, :description, "")

        chapter = Map.put(chapter, :series, nil)

        files =
          Enum.with_index(chapter.files)
          |> Enum.map(fn {_, i} -> ~p"/page/#{chapter.id}/#{i + 1}" end)

        order = chapter.page_order

        socket =
          socket
          |> assign(page_title: chapter.title)
          |> assign(series: series)
          |> assign_new(:chapters, fn -> Chapter.list(series) end)
          |> assign(chapter: chapter)
          |> assign(source: chapter.source)
          |> assign(files: %{files: files, order: order})

        {:ok, socket}
    end
  end

  def handle_params(params, _path, socket) do
    {:ok, socket} = mount(params, %{}, socket)
    send(self(), "update_files")
    {:noreply, socket}
  end

  def handle_info("update_files", socket) do
    socket =
      push_event(socket, "files", %{
        files: socket.assigns.files.files,
        order: socket.assigns.files.order
      })

    {:noreply, socket}
  end

  def handle_event("order-get", _, socket) do
    {:ok, chapter} = socket.assigns.chapter |> LL.PageDetect.detect()

    files =
      Enum.with_index(chapter.files)
      |> Enum.map(fn {_, i} -> ~p"/page/#{chapter.id}/#{i + 1}" end)

    order = chapter.page_order

    socket =
      socket
      |> assign(chapter: chapter)
      |> assign(files: %{files: files, order: order})
      |> push_event("files", %{
        files: files,
        order: order
      })

    {:noreply, socket}
  end

  def handle_event("order-save", %{"order" => order}, socket) do
    case Jason.decode(order) do
      {:ok, order} ->
        Ecto.Changeset.change(socket.assigns.chapter, %{page_order: order})
        |> Repo.update()

        LL.PageDetect.write_exif(socket.assigns.chapter.files, order)

        send(self(), "update_files")
        {:noreply, socket |> assign(files: %{socket.assigns.files | order: order})}

      _ ->
        {:noreply, socket}
    end
  end

  def handle_event("order-set", %{"index" => index, "n" => n}, socket) do
    {index, _} = Integer.parse(index)
    {n, _} = Integer.parse(n)
    order = socket.assigns.files.order |> List.replace_at(index, n)

    Ecto.Changeset.change(socket.assigns.chapter, %{page_order: order})
    |> Repo.update()

    send(self(), "update_files")
    {:noreply, socket |> assign(files: %{socket.assigns.files | order: order})}
  end

  def handle_event("order-alt", %{"index" => index, "n" => n}, socket) do
    {index, _} = Integer.parse(index)
    {n, _} = Integer.parse(n)

    order = socket.assigns.files.order
    a = Enum.drop(order, index) |> swap(n)
    b = Enum.take(order, index)
    order = b ++ a

    Ecto.Changeset.change(socket.assigns.chapter, %{page_order: order})
    |> Repo.update()

    send(self(), "update_files")
    {:noreply, socket |> assign(files: %{socket.assigns.files | order: order})}
  end

  def handle_event("order-reset", %{"n" => n}, socket) do
    {n, _} = Integer.parse(n)
    order = socket.assigns.files.order |> reset(n)

    Ecto.Changeset.change(socket.assigns.chapter, %{page_order: order})
    |> Repo.update()

    send(self(), "update_files")
    {:noreply, socket |> assign(files: %{socket.assigns.files | order: order})}
  end

  def handle_event("move", %{"index" => index}, socket) do
    {index, _} = Integer.parse(index)

    {:noreply,
     socket
     |> push_event("move", %{
       index: index
     })}
  end

  def swap([0 | tail], 1), do: [1] ++ swap(tail, 0)
  def swap([1 | tail], 1), do: [1] ++ swap(tail, 0)
  def swap(tail, 1), do: tail
  def swap([0 | tail], 0), do: [0] ++ swap(tail, 1)
  def swap([1 | tail], 0), do: [0] ++ swap(tail, 1)
  def swap(tail, 0), do: tail

  def reset([2 | tail], _), do: [2] ++ reset(tail, 0)
  def reset([0 | tail], 1), do: [1] ++ reset(tail, 0)
  def reset([1 | tail], 1), do: [1] ++ reset(tail, 0)
  def reset([0 | tail], 0), do: [0] ++ reset(tail, 1)
  def reset([1 | tail], 0), do: [0] ++ reset(tail, 1)
  def reset([], _), do: []
end
