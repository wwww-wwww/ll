defmodule LLWeb.CoreComponents do
  use Phoenix.Component
  alias LLWeb.Router.Helpers, as: Routes

  def nav(assigns) do
    ~H"""
    <.link
      navigate={Routes.live_path(@socket, @view)}
      class={if(@socket.private.root_view == @view, do: ["active"], else: []) ++ [assigns[:class]]}
    >
      <span>{@view.title()}{if assigns[:suffix], do: @suffix}</span>
    </.link>
    """
  end

  def relative_time(nil), do: nil

  def relative_time(time) do
    if Timex.diff(DateTime.utc_now(), time, :duration) > Timex.Duration.from_seconds(86400) do
      Timex.format!(time, "{YYYY}-{0M}-{0D}")
    else
      Timex.format!(time, "{relative}", :relative)
    end
  end

  def is_multi?(%LL.MultiSeries{}), do: true
  def is_multi?(_), do: false
end
