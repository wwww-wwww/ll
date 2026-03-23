defmodule LLWeb.PageView do
  use LLWeb, :view
  use Phoenix.Component

  alias LL.{Category, Repo, Series}

  @tag_types %{
    0 => "",
    1 => "Series",
    2 => "Author",
    3 => "Group",
    4 => "Category"
  }

  def replace_links(assigns, body) do
    Regex.scan(~r/{(.+)?}/, body)
    |> Enum.reduce(body, fn [match, group], acc ->
      replace =
        group
        |> String.split(",")
        |> case do
          [":library", id] ->
            series = Repo.get(Series, id)

            ~H"""
            <.link navigate={~p"/library/#{id}"}>{series.title}</.link>
            """
            |> Phoenix.HTML.Safe.to_iodata()
            |> IO.iodata_to_binary()

          _ ->
            group
        end

      String.replace(acc, match, replace)
    end)
    |> raw
  end

  def key_string(key) do
    case key do
      {a, b} ->
        key =
          to_string(a)
          |> String.split(".")
          |> Enum.at(-1)

        "{#{key}, #{b}}"

      a ->
        a
    end
  end

  def tag_text(tag) do
    case @tag_types[tag.type] do
      "" -> tag.name
      label -> "#{label}: #{tag.name}"
    end
  end

  def categories() do
    Repo.all(Category)
  end

  def authors(tags) do
    tags
    |> Enum.filter(&(&1.type == 2))
  end

  def sort_tags(tags) do
    Enum.sort_by(tags, &{-&1.type, &1.id})
  end

  def tag_type(tag) do
    case @tag_types[tag.type] do
      "" -> "Normal"
      type -> type
    end
  end

  def percent(n), do: round(n * 10000) / 100

  def percentile(list, n) do
    s = Enum.sort(list)
    r = n / 100.0 * (length(list) - 1)
    f = :erlang.trunc(r)
    lower = Enum.at(s, f)
    upper = Enum.at(s, f + 1)
    lower + (upper - lower) * (r - f)
  end

  def mean(list), do: Enum.sum(list) / length(list)

  def var(list) do
    list_mean = mean(list)
    list |> Enum.map(fn x -> (list_mean - x) * (list_mean - x) end) |> mean
  end
end
