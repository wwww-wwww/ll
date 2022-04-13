defmodule LLWeb.IndexLive do
  use LLWeb, :live_view

  alias LL.DB

  @limit 20

  def render(assigns) do
    LLWeb.PageView.render("index.html", assigns)
  end

  def mount(%{"q" => query, "page" => page}, _session, socket) do
    page =
      to_string(page)
      |> Integer.parse()
      |> elem(0)

    {size, page, results} = search(query, page, @limit)

    apk_date =
      case File.lstat("apk/app-standard-universal-debug.apk") do
        {:ok, %{ctime: {date, _}}} -> Date.from_erl!(date) |> to_string()
        _ -> nil
      end

    {:ok,
     assign(socket,
       n_files: DB.n_files(),
       original_filesize: DB.get(:original_filesize),
       filesize: DB.get(:filesize),
       query: query,
       results: results,
       suggestions: [],
       total: size,
       pages: ceil(size / @limit),
       page: page,
       limit: @limit,
       apk_date: apk_date
     )}
  end

  def mount(%{"page" => page}, session, socket) do
    mount(%{"q" => "", "page" => page}, session, socket)
  end

  def mount(%{"q" => query}, session, socket) do
    mount(%{"q" => query, "page" => 1}, session, socket)
  end

  def mount(_params, session, socket) do
    mount(%{"q" => ""}, session, socket)
  end

  def handle_params(%{"q" => query, "page" => page}, _session, socket) do
    page =
      to_string(page)
      |> Integer.parse()
      |> elem(0)

    {size, page, results} = search(query, page, @limit)

    {:noreply,
     assign(socket,
       query: query,
       results: results,
       suggestions: [],
       total: size,
       pages: ceil(size / @limit),
       page: page,
       limit: @limit
     )}
  end

  def handle_params(%{"q" => query}, session, socket) do
    handle_params(%{"q" => query, "page" => socket.assigns.page}, session, socket)
  end

  def handle_params(%{"page" => page}, session, socket) do
    handle_params(%{"q" => socket.assigns.query, "page" => page}, session, socket)
  end

  def handle_params(_params, _session, socket) do
    {:noreply, socket}
  end

  @spec handle_event(<<_::48>>, map, Phoenix.LiveView.Socket.t()) ::
          {:noreply, Phoenix.LiveView.Socket.t()}
  def handle_event("search", %{"q" => query}, socket) do
    socket =
      socket
      |> push_patch(
        to: Routes.live_path(socket, LLWeb.IndexLive, %{"q" => query}),
        replace: true
      )

    {:noreply, socket}
  end

  @re_search ~r/((?:-){0,1}(?:\"(?:\\(?:\\\\)*\")+(?:[^\\](?:\\(?:\\\\)*\")+|[^\"])*\"|\"(?:[^\\](?:\\(?:\\\\)*\")+|[^\"])*\"|[^ ]+))/iu

  defp search(query, page, limit) do
    {terms_include, terms_exclude} =
      Regex.scan(@re_search, query)
      |> Enum.map(&Enum.at(&1, 1))
      |> Enum.map(&String.downcase(&1))
      |> Enum.map(fn term ->
        case term do
          "-" <> term ->
            {false, term}

          term ->
            {true, term}
        end
      end)
      |> Enum.map(fn {inc, term} ->
        {inc,
         if String.length(term) > 1 and String.starts_with?(term, "\"") and
              String.ends_with?(term, "\"") do
           String.slice(term, 1, String.length(term) - 2)
         else
           term
         end}
      end)
      |> Enum.map(&{elem(&1, 0), String.replace(elem(&1, 1), "\\\"", "\"")})
      |> Enum.filter(&(String.length(elem(&1, 1)) > 0))
      |> Enum.reduce({[], []}, fn {term_include, term}, {include, exclude} ->
        if term_include do
          {include ++ [term], exclude}
        else
          {include, exclude ++ [term]}
        end
      end)

    results =
      DB.all()
      |> Enum.filter(fn s ->
        Enum.all?(terms_include, fn term ->
          Enum.any?(s.search, &String.contains?(&1, term))
        end) and
          Enum.all?(terms_exclude, fn term ->
            Enum.all?(s.search, &(not String.contains?(&1, term)))
          end)
      end)

    pages = length(results)

    page = min(max(page, 1), ceil(pages / limit))

    results =
      results
      |> Enum.drop((page - 1) * limit)
      |> Enum.take(limit)

    {pages, page, results}
  end
end
