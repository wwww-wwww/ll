defmodule LLWeb.PageView do
  use LLWeb, :view
  use Phoenix.Component

  @status %{
    0 => "Unknown",
    1 => "Ongoing",
    2 => "Completed",
    3 => "Licensed",
    4 => "Publishing finished",
    5 => "Canceled",
    6 => "On hiatus"
  }

  def status(series), do: @status[series.status]
end
