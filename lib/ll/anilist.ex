defmodule LL.Anilist do
  require Logger
  require LL.Downloader

  alias LL.{Downloader, MultiSeries, Series, Repo, Message}
  alias LLWeb.Endpoint

  @endpoint "https://graphql.anilist.co"

  def cover(id) do
    query = """
    query ($id: Int) {
      Media (id: $id) {
        coverImage {
          extraLarge
        }
      }
    }
    """

    body = Jason.encode!(%{query: query, variables: %{id: id}})

    HTTPoison.request(%HTTPoison.Request{
      method: "POST",
      url: @endpoint,
      body: body,
      headers: [
        {"Accept", "application/json"},
        {"Content-Type", "application/json"}
      ],
      options: [recv_timeout: 30000]
    })
    |> case do
      {:ok, %{body: body}} ->
        {:ok,
         Jason.decode!(body)
         |> Map.get("data")
         |> Map.get("Media")
         |> Map.get("coverImage")
         |> Map.get("extraLarge")}

      err ->
        err
    end
  end

  def download_cover(cover_url, entry) do
    Downloader.get cover_url do
      {:ok, body, _headers} ->
        ext = cover_url |> URI.parse() |> Map.get(:path) |> Path.extname()
        filename = "#{Ecto.UUID.generate()}#{ext}"
        path = Path.expand("covers/#{filename}")

        Logger.info("Saved cover to #{path}")

        {:ok, file} = File.open(path, [:write])
        IO.binwrite(file, body)
        File.close(file)

        System.cmd("uv", ["run", "covers.py", path, "thumbnails/#{filename}"])

        {:ok, entry} =
          Ecto.Changeset.change(entry, %{thumbnail_path: path})
          |> Repo.update()

        case entry do
          %MultiSeries{} ->
            LLWeb.SeriesLive.update(entry)
            Endpoint.broadcast("thumb:multi:#{entry.id}", "update", entry)

          %Series{} ->
            LLWeb.SeriesLive.update(entry)
            Endpoint.broadcast("thumb:series:#{entry.id}", "update", entry)
        end

      err ->
        Message.error(err)
    end
  end

  def download_cover(entry) when not is_nil(entry.anilist_id) do
    case cover(entry.anilist_id) do
      {:ok, cover_url} ->
        download_cover(cover_url, entry)

      err ->
        Message.error(err)
    end
  end

  def download_cover(_) do
  end
end
