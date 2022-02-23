defmodule LL.DB do
  use Agent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Chapter, Series}

  @cooldown 300

  defstruct time: nil,
            n_files: 0,
            all: [],
            all_safe: "{}"

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
            chapters -> chapters |> Enum.max_by(& &1.date) |> Map.get(:date)
          end

        tags = tag_names(s.tags)
        tag_ids = tag_ids(s.tags)

        %{
          type: :series,
          date: date,
          e: s,
          search: ([s.title] ++ tags ++ tag_ids) |> Enum.map(&String.downcase(&1))
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

    %__MODULE__{time: Time.utc_now(), n_files: n_files, all: all, all_safe: all_safe}
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

      {state |> Map.get(key), state}
    end)
  end

  def n_files(), do: get(:n_files)

  def all(), do: get(:all)

  def all_safe(), do: get(:all_safe)
end
