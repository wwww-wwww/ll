defmodule LL.Chapter do
  use Ecto.Schema

  import Ecto.Query, only: [from: 2]
  alias LL.{Repo, Chapter}

  schema "chapters" do
    belongs_to :source, LL.Source
    belongs_to :series, LL.Series
    field :url, :string

    field :title, :string
    field :number, :float
    field :date, :utc_datetime
    field :scanlator, :string

    field :files, {:array, :string}

    field :hidden, :boolean

    field :page_order, {:array, :integer}

    timestamps()
  end

  def list(series) do
    from(c in Chapter,
      where: c.series_id == ^series.id,
      order_by: [desc: c.number, desc: c.scanlator, desc: c.date]
    )
    |> Repo.all()
  end

  def downloaded?(chapter),
    do: chapter.files != nil and Enum.all?(chapter.files, &File.exists?(&1))
end
