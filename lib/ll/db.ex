defmodule LL.DB do
  use Agent

  import Ecto.Query, only: [from: 2]

  alias LL.{Repo, Chapter, Series}

  defstruct time: nil,
            n_files: 0,
            all: []

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
      |> Stream.map(& &1.chapters)
      |> Enum.reduce([], &(&1 ++ &2))

    n_files =
      (chapters ++ series_chapters)
      |> Stream.map(& &1.files)
      |> Enum.reduce([], &(&1 ++ &2))
      |> Enum.filter(&String.ends_with?(&1, ".jxl"))
      |> length()

    series =
      Enum.map(series, fn s ->
        latest_chapter = s.chapters |> Enum.max_by(& &1.date)
        c_tags = Enum.map(s.chapters, & &1.tags) |> List.flatten()

        tags = tag_names(s.tags ++ c_tags)
        tag_ids = tag_ids(s.tags ++ c_tags)

        %{
          type: :series,
          date: latest_chapter.date,
          e: s,
          tags: tags,
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
            tags: tags,
            search: ([c.title] ++ tags ++ tag_ids) |> Enum.map(&String.downcase(&1))
          }
        end
      )

    all =
      (series ++ chapters)
      |> Enum.sort_by(& &1.date, {:desc, Date})

    %__MODULE__{time: Time.utc_now(), n_files: n_files, all: all}
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
        if is_nil(state.time) or Time.diff(now, state.time) > 600 do
          update()
        else
          state
        end

      {state |> Map.get(key), state}
    end)
  end

  def n_files(), do: get(:n_files)

  def all(), do: get(:all)
end
