defmodule LL.DB do
  use Agent
  require Ecto.Query.API

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Chapter, Series, Tag}

  @cooldown 300

  defstruct time: nil,
            n_files: 0,
            all: [],
            all_safe: "{}",
            original_filesize: 0,
            filesize: 0

  def start_link(_opts) do
    Agent.start_link(fn -> %__MODULE__{} end, name: __MODULE__)
  end

  def series?(%Series{}), do: true
  def series?(_), do: false

  def chapter?(%Chapter{}), do: true
  def chapter?(_), do: false

  def tag_names(tags), do: Enum.map(tags, & &1.name)
  def tag_ids(tags), do: Enum.map(tags, & &1.id)

  def update() do
    series =
      Repo.all(Series)
      |> Repo.preload([:tags, {:chapters, :tags}])

    chapters =
      Repo.all(from(u in Chapter, where: is_nil(u.series_id)))
      |> Repo.preload(:tags)

    series_chapters =
      series
      |> Enum.map(& &1.chapters)
      |> List.flatten()

    original_filesize =
      (chapters ++ series_chapters)
      |> Enum.map(& &1.original_files_sizes)
      |> List.flatten()
      |> Stream.filter(&(!is_nil(&1)))
      |> Enum.sum()

    filesize =
      (chapters ++ series_chapters)
      |> Stream.map(& &1.filesize)
      |> Stream.filter(&(!is_nil(&1)))
      |> Enum.sum()

    n_files =
      (chapters ++ series_chapters)
      |> Enum.map(& &1.files)
      |> List.flatten()
      |> Enum.filter(&String.ends_with?(&1, ".jxl"))
      |> length()

    series =
      Enum.map(series, fn s ->
        date =
          case s.chapters do
            [] -> s.inserted_at
            chapters -> chapters |> Enum.max_by(& &1.date, Date) |> Map.get(:date)
          end

        tags = tag_names(s.tags)
        tag_ids = tag_ids(s.tags)

        %{
          type: :series,
          date: date,
          e: s,
          search: ([s.id, s.title, "series"] ++ tags ++ tag_ids) |> Enum.map(&String.downcase(&1))
        }
      end)

    chapters =
      Enum.map(
        chapters,
        fn c ->
          tags = tag_names(c.tags)
          tag_ids = tag_ids(c.tags)

          %{
            type: :chapter,
            date: c.date,
            e: c,
            search: ([c.title] ++ tags ++ tag_ids) |> Enum.map(&String.downcase(&1))
          }
        end
      )

    all =
      (series ++ chapters)
      |> Enum.sort_by(& &1.date, {:desc, Date})

    all_safe =
      all
      |> Enum.map(
        &%{
          id: &1.e.id,
          title: &1.e.title,
          cover: &1.e.cover,
          type: &1.type,
          date: &1.date,
          tags: Enum.map(&1.e.tags, fn tag -> %{name: tag.name, type: tag.type} end)
        }
      )

    %__MODULE__{
      time: Time.utc_now(),
      n_files: n_files,
      all: all,
      all_safe: all_safe,
      filesize: filesize,
      original_filesize: original_filesize
    }
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

  def n_files(), do: get(:n_files)

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
