defmodule LL.Chapter do
  use Ecto.Schema

  import Ecto.Changeset

  alias LL.{Repo, CriticalWriter}

  @primary_key false
  schema "chapters" do
    field :id, :string, primary_key: true
    field :number, :integer
    field :title, :string
    field :source, :string
    field :source_id, :string

    field :date, :date

    field :cover, :string
    field :files, {:array, :string}
    field :filesize, :integer, default: 0

    field :original_files, {:array, :string}
    field :original_files_sizes, {:array, :integer}

    field :enc, :string
    field :enc_params, :string

    belongs_to :series, LL.Series, type: :string
    many_to_many :tags, LL.Tag, join_through: LL.ChaptersTags, on_replace: :delete

    timestamps()
  end

  def change(chapter, params) do
    chapter
    |> cast(params, [
      :id,
      :number,
      :title,
      :source,
      :source_id,
      :date,
      :cover,
      :files,
      :filesize,
      :enc,
      :enc_params,
      :original_files,
      :original_files_sizes
    ])
  end

  def put_series(changeset, nil), do: changeset
  def put_series(changeset, series), do: put_assoc(changeset, :series, series)

  def put_tags(changeset, tags), do: put_assoc(changeset, :tags, tags)

  def update_file(id, n, new_path, encoded) do
    CriticalWriter.add(fn ->
      chapter = Repo.get(__MODULE__, id)
      new_files = Enum.take(chapter.files, n) ++ [new_path] ++ Enum.drop(chapter.files, n + 1)

      if encoded do
        new_filesize =
          chapter.files
          |> Stream.filter(&(not String.starts_with?(&1, "tmp")))
          |> Stream.filter(&(not String.starts_with?(&1, "/")))
          |> Stream.map(&(LL.files_root() <> &1))
          |> Stream.map(&(File.stat!(&1) |> Map.get(:size)))
          |> Enum.sum()

        __MODULE__.change(chapter, %{
          enc: Application.get_env(:ll, :cjxl),
          enc_params: "-q 100 -e 9 -E 3 -I 1",
          files: new_files,
          filesize: new_filesize
        })
      else
        __MODULE__.change(chapter, %{
          files: new_files
        })
      end
      |> Repo.update()
    end)
  end

  def update_original_filesize(id, n, filesize) do
    CriticalWriter.add(fn ->
      chapter = Repo.get(__MODULE__, id)

      new_files_sizes =
        chapter.original_files_sizes
        |> Enum.take(n)
        |> Kernel.++([filesize])
        |> Kernel.++(Enum.drop(chapter.original_files_sizes, n + 1))

      __MODULE__.change(chapter, %{original_files_sizes: new_files_sizes})
      |> Repo.update()
    end)
  end

  def files_path(%__MODULE__{series_id: series_id, source_id: source_id} = chapter) do
    root =
      Path.join(
        LL.files_root(),
        LL.Sources.source_module(chapter.source).file_path()
      )

    case series_id do
      nil -> Path.join(root, source_id)
      series_id -> Path.join(root, series_id) |> Path.join(source_id)
    end
  end

  def delete_files(%__MODULE__{} = chapter) do
    Enum.each(chapter.files, &File.rm(Path.join(LL.files_root(), &1)))
    files_path(chapter) |> File.rmdir()
  end

  def delete(%__MODULE__{} = chapter) do
    delete_files(chapter)

    case chapter.cover do
      nil -> nil
      cover -> Path.join(LL.files_root(), cover) |> File.rm()
    end

    Repo.delete(chapter)
  end

  def get_category(%__MODULE__{} = chapter) do
    case Repo.preload(chapter, [:tags, :series]) do
      %{series: nil, tags: tags} ->
        tags

      %{series: series} ->
        Repo.preload(series, [:tags])
        |> Map.get(:tags)
    end
    |> Enum.filter(&(&1.type == 4))
    |> Enum.at(0)
    |> LL.Category.from_tag()
  end
end
