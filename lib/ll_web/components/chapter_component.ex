defmodule LLWeb.ChapterComponent do
  use LLWeb, :live_component

  alias LL.Repo

  def render(assigns) do
    ~H"""
    <div class={["ChapterComponent", assigns[:selected] && "selected", @chapter.hidden && "hidden"]}>
      <% downloaded = @chapter.files != nil && Enum.filter(@chapter.files, &File.exists?/1) %>
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
      <div class="body">
        <%= if downloaded do %>
          <.link patch={@href}>
            <div><span class="title">{@chapter.title}</span></div>
            <div>
              <span class="date">{relative_time(@chapter.date)}</span>
              <span :if={assigns[:show_source]} class="source">{@source.name}</span>
              <span class="scanlator">{@chapter.scanlator}</span>
            </div>
          </.link>
        <% else %>
          <div>
            <div><span class="title">{@chapter.title}</span></div>
            <div>
              <span class="date">{relative_time(@chapter.date)}</span>
              <span :if={assigns[:show_source]} class="source">{@source.name}</span>
              <span class="scanlator">{@chapter.scanlator}</span>
            </div>
          </div>
        <% end %>
      </div>

      <div class="extra">
        <%= if assigns[:show_hide] do %>
          <%= if @chapter.hidden != true do %>
            <button phx-click="hide-chapter" phx-target={@myself}>Hide</button>
          <% else %>
            <button phx-click="unhide-chapter" phx-target={@myself}>Show</button>
          <% end %>
        <% end %>
        <.link
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

  def update(assigns, socket) do
    socket =
      socket
      |> subscribe_once("chapter:#{assigns.chapter.id}")
      |> assign(assigns)

    {:ok, socket}
  end

  def handle_event("hide-chapter", _params, socket) do
    socket.assigns.chapter
    |> Ecto.Changeset.change(%{hidden: true})
    |> Repo.update()
    |> case do
      {:ok, chapter} -> Endpoint.broadcast("chapter:#{chapter.id}", "update", chapter)
      _ -> nil
    end

    {:noreply, socket}
  end

  def handle_event("unhide-chapter", _params, socket) do
    socket.assigns.chapter
    |> Ecto.Changeset.change(%{hidden: false})
    |> Repo.update()
    |> case do
      {:ok, chapter} -> Endpoint.broadcast("chapter:#{chapter.id}", "update", chapter)
      _ -> nil
    end

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
