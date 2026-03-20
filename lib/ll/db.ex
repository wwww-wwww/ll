defmodule LL.DB do
  use Agent
  require Ecto.Query.API

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Chapter, Series, Tag}

  @cooldown 300

  defstruct time: nil,
            all: [],
            all_safe: "{}"

  def start_link(_opts) do
    Agent.start_link(fn -> %__MODULE__{} end, name: __MODULE__)
  end

  def series?(%Series{}), do: true
  def series?(_), do: false

  def chapter?(%Chapter{}), do: true
  def chapter?(_), do: false

  def update() do
  end

  def reset() do
    Agent.update(__MODULE__, fn _ ->
      %__MODULE__{}
    end)
  end

  def get(key) do
    Agent.get_and_update(__MODULE__, fn state ->
      now = Time.utc_now()

      state =
        if is_nil(state.time) or abs(Time.diff(now, state.time)) > @cooldown do
          update()
        else
          state
        end

      {Map.get(state, key), state}
    end)
  end

  def all(), do: get(:all)

  def all_safe(), do: get(:all_safe)

  def search_tags(terms) do
    conditions =
      Enum.reduce(terms, false, &Ecto.Query.dynamic([t], ilike(t.name, ^"%#{&1}%") or ^&2))

    from t in Tag, where: ^conditions
  end

  def search(terms) when is_list(terms) do
    nil
  end

  @re_search ~r/((?:-){0,1}(?:\"(?:\\(?:\\\\)*\")+(?:[^\\](?:\\(?:\\\\)*\")+|[^\"])*\"|\"(?:[^\\](?:\\(?:\\\\)*\")+|[^\"])*\"|[^ ]+))/iu

  def search(query) do
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

    {terms_include, terms_exclude}
  end
end
