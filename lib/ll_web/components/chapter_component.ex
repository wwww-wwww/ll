defmodule LLWeb.ChapterComponent do
  use LLWeb, :live_component

  alias LL.Repo

  def render(assigns) do
    ~H"""
    <div
      class={["ChapterComponent", assigns[:selected] && "selected", @chapter.hidden && "hidden"]}
      data-chapter-id={@chapter.id}
      data-pages={page_count(@chapter)}
      data-order={page_order(@chapter)}
    >
      <% downloaded =
        @chapter.files != nil && Enum.filter(@chapter.files, &(&1 |> String.starts_with?("/"))) %>
      <div :if={@chapter.files == nil or length(downloaded) != length(@chapter.files)} class="extra">
        <span :if={@chapter.files}>{length(downloaded)}/{length(@chapter.files)}</span>
        <button
          :if={assigns[:user]}
          phx-click="download_chapter"
          phx-target={@myself}
          value={@chapter.id}
          class="material-symbols-rounded"
        >
          download
        </button>
      </div>

      <% available = readable?(@chapter) %>
      <div class="body">
        <.link patch={if available, do: @href} disabled={not available}>
          <div><span class="title">{@chapter.title}</span></div>
          <div>
            <span class="date">{relative_time(@chapter.date)}</span>
            <span :if={assigns[:show_source]} class="source">{@source.name}</span>
            <span class="number">{@chapter.number}</span>
            <span class="scanlator">{@chapter.scanlator}</span>
          </div>
        </.link>
      </div>

      <div class="extra">
        <%= if assigns[:show_edit] do %>
          <%= if @chapter.hidden != true do %>
            <button phx-click="hide" phx-target={@myself}>Hide</button>
          <% else %>
            <button phx-click="unhide" phx-target={@myself}>Show</button>
          <% end %>
          <button phx-click="delete" phx-target={@myself}>Delete</button>
        <% end %>
        <.link
          :if={not is_nil(@source)}
          class="button material-symbols-rounded"
          target="_blank"
          href={Path.join(@source.base_url, @chapter.url)}
        >
          globe
        </.link>
      </div>
    </div>
    """
  end

  @doc """
  Whether every one of [chapter]'s files is downloaded, and so whether it can be read at all.
  """
  def readable?(chapter) do
    chapter.files != nil and
      length(Enum.filter(chapter.files, &String.starts_with?(&1, "/"))) == length(chapter.files)
  end

  # The two the reader needs to open a chapter without asking the server - see `chapterPages` in
  # hooks.ts. Left off a chapter that is not fully downloaded, which is the same answer its dead
  # link gives.
  defp page_count(chapter), do: readable?(chapter) && length(chapter.files)

  defp page_order(chapter) do
    readable?(chapter) && chapter.page_order && Jason.encode!(chapter.page_order)
  end

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("chapter:#{assigns.chapter.id}")
      |> assign(assigns)

    {:ok, socket}
  end

  def handle_event("hide", _params, socket) do
    socket.assigns.chapter
    |> Ecto.Changeset.change(%{hidden: true})
    |> Repo.update()
    |> case do
      {:ok, chapter} -> Endpoint.broadcast("chapter:#{chapter.id}", "update", chapter)
      _ -> nil
    end

    {:noreply, socket}
  end

  def handle_event("unhide", _params, socket) do
    socket.assigns.chapter
    |> Ecto.Changeset.change(%{hidden: false})
    |> Repo.update()
    |> case do
      {:ok, chapter} -> Endpoint.broadcast("chapter:#{chapter.id}", "update", chapter)
      _ -> nil
    end

    {:noreply, socket}
  end

  def handle_event("delete", _params, socket) do
    Repo.delete(socket.assigns.chapter)

    chapters = LL.Chapter.list(%{id: socket.assigns.chapter.series_id})

    Endpoint.broadcast("chapters:#{socket.assigns.chapter.series_id}", "update", chapters)

    {:noreply, socket}
  end

  def handle_event("download_chapter", %{"value" => chapter_id}, socket) do
    chapter = LL.Repo.get(LL.Chapter, chapter_id) |> LL.Repo.preload(source: :extension)
    LL.ExtensionManager.download_chapter(chapter, chapter.source)

    {:noreply, socket}
  end

  defmacro __using__(_opts) do
    quote do
      def handle_info(%{topic: "chapter:" <> _, event: "update", payload: chapter}, socket) do
        LLWeb.ChapterComponent.update_assigns(chapter.id, chapter: chapter)
        {:noreply, socket}
      end
    end
  end
end
