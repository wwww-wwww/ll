defmodule LL.Anilist do
  use Ecto.Schema
  import Ecto.Query

  schema "anilist" do
    field :title, :string
    field :artist, :string
    field :author, :string
    field :description, :string
    field :genre, :string
    field :status, :integer
    field :thumbnail_path, :string
    field :thumbnail_hash, :string

    has_many :aliases, LL.Alias

    timestamps()
  end

  require Logger
  require LL.Downloader

  alias LL.{Downloader, MultiSeries, Series, Repo, Message}
  alias LLWeb.Endpoint

  @endpoint "https://graphql.anilist.co"

  def search(title), do: media("$title: String", "search: $title", %{title: title})

  def fetch(id) do
    with {:ok, [media | _]} <- media("$id: Int", "id: $id", %{id: id}), do: {:ok, media}
  end

  defp media(decl, filter, variables) do
    query = """
    query (#{decl}) {
      Page {
        media (#{filter}, type: MANGA) {
          siteUrl
          title {
            english
            romaji
            native
          }
          status
          staff {
            edges {
              role
              node {
                name {
                  full
                }
              }
            }
          }
          coverImage {
            extraLarge
          }
          id
          description
          synonyms
          status
        }
      }
    }
    """

    body = Jason.encode!(%{query: query, variables: variables})

    with {:ok, %{body: body}} <-
           HTTPoison.request(%HTTPoison.Request{
             method: "POST",
             url: "https://graphql.anilist.co",
             body: body,
             headers: [
               {"Accept", "application/json"},
               {"Content-Type", "application/json"},
               {"Referer", "https://graphql.anilist.co"}
             ],
             options: [recv_timeout: 30000]
           }),
         {:ok, %{data: %{Page: %{media: results}}}} <- Jason.decode(body, keys: :atoms) do
      {:ok, results}
    else
      err -> Message.error(err)
    end
  end

  def status("FINISHED"), do: 2
  def status("RELEASING"), do: 1
  def status("NOT_YET_RELEASED"), do: 0
  def status("CANCELLED"), do: 5
  def status("HIATUS"), do: 6

  def viewer(token) do
    body = Jason.encode!(%{query: "query { Viewer { id name } }"})

    with {:ok, %{status_code: 200, body: body}} <-
           HTTPoison.post(
             @endpoint,
             body,
             [
               {"Accept", "application/json"},
               {"Content-Type", "application/json"},
               {"Authorization", "Bearer #{token}"}
             ],
             recv_timeout: 30000
           ),
         {:ok, %{"data" => %{"Viewer" => %{"id" => _, "name" => _} = viewer}}} <-
           Jason.decode(body) do
      {:ok, viewer}
    else
      err -> {:error, err}
    end
  end

  def progress(token, id) do
    query = """
    query ($id: Int) {
      Media (id: $id) {
        mediaListEntry {
          progress
        }
      }
    }
    """

    body = Jason.encode!(%{query: query, variables: %{id: id}})

    with {:ok, %{status_code: 200, body: body}} <-
           HTTPoison.post(
             @endpoint,
             body,
             [
               {"Accept", "application/json"},
               {"Content-Type", "application/json"},
               {"Authorization", "Bearer #{token}"}
             ],
             recv_timeout: 30000
           ),
         {:ok, %{"data" => %{"Media" => media}}} <- Jason.decode(body) do
      {:ok, get_in(media, ["mediaListEntry", "progress"])}
    else
      err -> {:error, err}
    end
  end

  def set_progress(token, id, progress) do
    query = """
    mutation ($id: Int, $progress: Int) {
      SaveMediaListEntry (mediaId: $id, progress: $progress) {
        progress
      }
    }
    """

    body = Jason.encode!(%{query: query, variables: %{id: id, progress: progress}})

    with {:ok, %{status_code: 200}} <-
           HTTPoison.post(
             @endpoint,
             body,
             [
               {"Accept", "application/json"},
               {"Content-Type", "application/json"},
               {"Authorization", "Bearer #{token}"}
             ],
             recv_timeout: 30000
           ) do
      :ok
    else
      err -> {:error, err}
    end
  end

  # Raises the Anilist progress to n, never lowering it. Returns the resulting progress.
  def advance_progress(token, id, n) do
    with {:ok, remote} <- progress(token, id) do
      remote = remote || 0

      if n > remote do
        with :ok <- set_progress(token, id, n), do: {:ok, n}
      else
        {:ok, remote}
      end
    end
  end

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

  def aliases(%{anilist: %__MODULE__{aliases: aliases}}) when is_list(aliases), do: aliases
  def aliases(_), do: []

  def field(%{anilist: %__MODULE__{} = anilist} = entry, key) do
    with nil <- Map.get(anilist, key), do: field(Map.delete(entry, :anilist), key)
  end

  def field(entry, key) do
    with nil <- Map.get(entry, key) do
      case entry do
        %{series: %Series{} = series} -> field(series, key)
        _ -> nil
      end
    end
  end

  def title(entry), do: field(entry, :title)

  def thumbnail_path(entry) do
    own = Map.get(entry, :thumbnail_path)

    case entry do
      %{anilist: %__MODULE__{thumbnail_path: path}} when is_binary(path) ->
        if File.exists?(path), do: path, else: own

      _ ->
        own
    end
  end

  def has_thumbnail?(entry) do
    case thumbnail_path(entry) do
      nil -> false
      path -> File.exists?(path)
    end
  end

  defp broadcast(%__MODULE__{id: id} = anilist) do
    for s <- Repo.all(from(s in Series, where: s.anilist_id == ^id)) do
      s = %{s | anilist: anilist}
      LLWeb.SeriesLive.update(s)
      Endpoint.broadcast("thumb:series:#{s.id}", "update", s)
    end

    for m <- Repo.all(from(m in MultiSeries, where: m.anilist_id == ^id)) do
      m = %{m | anilist: anilist}
      LLWeb.SeriesLive.update(m)
      Endpoint.broadcast("thumb:multi:#{m.id}", "update", m)
    end
  end

  def download_cover(cover_url, %__MODULE__{} = anilist) do
    hash = :crypto.hash(:sha256, cover_url) |> Base.encode16(case: :lower)

    if anilist.thumbnail_hash == hash and has_thumbnail?(anilist),
      do: :ok,
      else: fetch_cover(cover_url, hash, anilist)
  end

  defp fetch_cover(cover_url, hash, anilist) do
    Downloader.get cover_url do
      {:ok, body, _headers} ->
        ext = cover_url |> URI.parse() |> Map.get(:path) |> Path.extname()
        filename = "#{Ecto.UUID.generate()}#{ext}"
        path = Path.expand("covers/#{filename}")

        Logger.info("Saved cover to #{path}")

        {:ok, file} = File.open(path, [:write])
        IO.binwrite(file, body)
        File.close(file)

        thumbnail_path = LL.Covers.encode(path)

        {:ok, anilist} =
          Ecto.Changeset.change(anilist, %{thumbnail_path: thumbnail_path, thumbnail_hash: hash})
          |> Repo.update()

        broadcast(anilist)

      err ->
        Message.error(err)
    end
  end

  def download_cover(%{anilist_id: id}) when not is_nil(id) do
    case cover(id) do
      {:ok, cover_url} ->
        download_cover(cover_url, Repo.get!(__MODULE__, id))

      err ->
        Message.error(err)
    end
  end

  def download_cover(_) do
  end
end
