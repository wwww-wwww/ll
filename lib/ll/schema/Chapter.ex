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
    field :path, :string
    field :files, {:array, :string}

    field :enc, :string
    field :enc_params, :string

    belongs_to :series, LL.Series, type: :string
    many_to_many :tags, LL.Tag, join_through: LL.ChaptersTags

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
      :path,
      :files,
      :enc,
      :enc_params
    ])
  end

  def put_series(changeset, series), do: put_assoc(changeset, :series, series)

  def put_tags(changeset, tags), do: put_assoc(changeset, :tags, tags)

  def update_file(id, n, new_path, encoded) do
    CriticalWriter.add(fn ->
      chapter = Repo.get(LL.Chapter, id)
      new_files = Enum.take(chapter.files, n) ++ [new_path] ++ Enum.drop(chapter.files, n + 1)

      if encoded do
        LL.Chapter.change(chapter, %{
          enc: Application.get_env(:ll, :cjxl),
          enc_params: "-q 100 -e 9 -E 3 -I 1",
          files: new_files
        })
      else
        LL.Chapter.change(chapter, %{
          files: new_files
        })
      end
      |> Repo.update()
    end)
  end
end