defmodule LLWeb.PageView do
  use LLWeb, :view

  alias LL.{Category, Repo}

  @tag_types %{
    0 => "",
    1 => "Series",
    2 => "Author",
    3 => "Group",
    4 => "Category"
  }

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

  def sort_tags(tags) do
    Enum.sort_by(tags, &{-&1.type, &1.id})
  end

  def tag_type(tag) do
    case @tag_types[tag.type] do
      "" -> "Normal"
      type -> type
    end
  end
end
