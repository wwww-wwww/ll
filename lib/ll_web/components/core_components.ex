defmodule LLWeb.CoreComponents do
  defmacro __using__(_opts) do
    quote do
      def live_component2(assigns) when is_map(assigns) do
        id = assigns[:id]

        {module, assigns} =
          assigns
          |> Map.delete(:__changed__)
          |> Map.pop(:module)

        if module == nil or not is_atom(module) do
          raise ArgumentError,
                ".live_component expects module={...} to be given and to be an atom, " <>
                  "got: #{inspect(module)}"
        end

        case module.__live__() do
          %{kind: :component} ->
            %Phoenix.LiveView.Component{id: module.id(id), assigns: assigns, component: module}

          %{kind: kind} ->
            raise ArgumentError,
                  "expected #{inspect(module)} to be a component, but it is a #{kind}"
        end
      end

      def relative_time(nil), do: nil

      def relative_time(time) do
        if Timex.diff(DateTime.utc_now(), time, :duration) > Timex.Duration.from_seconds(86400) do
          Timex.format!(time, "{YYYY}-{0M}-{D}")
        else
          Timex.format!(time, "{relative}", :relative)
        end
      end
    end
  end
end
