defmodule LL.ExtensionManager do
  use Agent

  require LL.Downloader
  alias LL.{Downloader, Repo, Extension, Source}

  @extension_repo "https://raw.githubusercontent.com/keiyoushi/extensions/repo/"
  @extensions_path "extensions"

  defstruct remote: [],
            local: []

  def start_link(_opts) do
    Agent.start_link(fn -> %__MODULE__{} end, name: __MODULE__)
  end

  def get() do
    Agent.get(__MODULE__, & &1)
  end

  def update_remote() do
    Downloader.get @extension_repo <> "index.json" do
      {:ok, body, _headers} ->
        case Jason.decode(body) do
          {:ok, arr} ->
            Agent.update(__MODULE__, &%__MODULE__{&1 | remote: arr})
            LLWeb.ExtensionsLive.update_remote(arr)

          err ->
            IO.inspect(err)
        end

      err ->
        IO.inspect(err)
    end
  end

  def update_local() do
    arr = Repo.all(Extension)
    Agent.update(__MODULE__, &%__MODULE__{&1 | local: arr})
    LLWeb.ExtensionsLive.update_local(arr)
  end

  def install(pkg) do
    get().remote
    |> Enum.filter(&(&1["pkg"] == pkg))
    |> case do
      [%{"apk" => apk, "name" => ext_name, "version" => ext_version}] ->
        Downloader.get @extension_repo <> "apk/" <> apk do
          {:ok, body, _headers} ->
            path = Path.expand(@extensions_path <> "/" <> apk)
            {:ok, file} = File.open(path, [:write])
            IO.binwrite(file, body)
            File.close(file)

            Downloader.post path, "http://localhost:8000/process_extension", :local do
              {:ok, body, _headers} ->
                with {:ok, sources} <- Jason.decode(body) do
                  Repo.transact(fn ->
                    {:ok, extension} =
                      Ecto.Changeset.change(%Extension{}, %{
                        name: ext_name,
                        pkg: pkg,
                        version: ext_version,
                        path: path
                      })
                      |> Repo.insert()

                    sources =
                      Enum.map(sources, fn source ->
                        Ecto.Changeset.change(%Source{}, %{
                          source_id: source["id"],
                          name: source["name"],
                          lang: source["lang"],
                          extension_id: extension.id
                        })
                        |> Repo.insert()
                        |> elem(1)
                      end)

                    {:ok, sources}
                  end)

                  update_local()
                else
                  err -> IO.inspect(err)
                end

              err ->
                IO.inspect(err)
            end

          err ->
            IO.inspect(err)
        end

      _ ->
        IO.inspect("nothing")
    end
  end
end
