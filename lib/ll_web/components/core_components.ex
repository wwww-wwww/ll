defmodule LLWeb.CoreComponents do
  defmacro __using__(_opts) do
    quote do
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
