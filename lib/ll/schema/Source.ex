defmodule LL.Source do
  use Ecto.Schema

  schema "sources" do
    belongs_to :extension, LL.Extension
    field :source_id, :integer
    field :name, :string
    field :lang, :string
    field :base_url, :string

    timestamps()
  end

  def start_bucket() do
    :ets.new(:sources_filters, [:named_table, :public])
  end

  def update_filters(source, filters) do
    :ets.insert(:sources_filters, {source.id, filters})
  end

  def get_filters(source) do
    case :ets.lookup(:sources_filters, source.id) do
      [{_, filters}] -> filters
      _ -> []
    end
  end
end
