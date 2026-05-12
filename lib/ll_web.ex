defmodule LLWeb do
  @moduledoc """
  The entrypoint for defining your web interface, such
  as controllers, views, channels and so on.

  This can be used in your application as:

      use LLWeb, :controller
      use LLWeb, :view

  The definitions below will be executed for every view,
  controller, etc, so keep them short and clean, focused
  on imports, uses and aliases.

  Do NOT define functions inside the quoted expressions
  below. Instead, define any helper function in modules
  and import those modules here.
  """

  def static_paths, do: ~w(assets thumbnail fonts images favicon.ico robots.txt)

  def router do
    quote do
      use Phoenix.Router, helpers: false

      # Import common connection and controller functions to use in pipelines
      import Plug.Conn
      import Phoenix.Controller
      import Phoenix.LiveView.Router
    end
  end

  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json]

      use Gettext, backend: LLWeb.Gettext

      import Plug.Conn

      unquote(verified_routes())
    end
  end

  def live_view do
    quote do
      use Phoenix.LiveView,
        layout: {LLWeb.Layouts, :live},
        container: {:div, class: __MODULE__ |> to_string() |> String.split(".") |> Enum.at(-1)}

      import Phoenix.Component

      unquote(html_helpers())
    end
  end

  def live_component do
    quote do
      use Phoenix.LiveComponent

      def id(n), do: "#{__MODULE__}-#{n}"

      def update_assigns(n, opts), do: send_update(__MODULE__, [{:id, id(n)} | opts])

      def subscribe_once(socket, topic) do
        key = String.to_atom("subscribe:#{topic}")

        if connected?(socket) do
          if socket.assigns |> Map.get(key) || false do
            socket
          else
            LLWeb.Endpoint.subscribe(topic)
            assign(socket, key, true)
          end
        else
          socket
        end
      end

      unquote(html_helpers())
    end
  end

  def html do
    quote do
      use Phoenix.Component

      # Import convenience functions from controllers
      import Phoenix.Controller,
        only: [get_csrf_token: 0, view_module: 1, view_template: 1]

      # Include general helpers for rendering HTML
      unquote(html_helpers())
    end
  end

  defp html_helpers do
    quote do
      # Translation
      use Gettext, backend: LLWeb.Gettext

      # HTML escaping functionality
      import Phoenix.HTML
      # Core UI components
      import LLWeb.CoreComponents

      # Common modules used in templates
      alias Phoenix.LiveView.JS
      alias LLWeb.Layouts

      alias LLWeb.Endpoint

      # Routes generation with the ~p sigil
      unquote(verified_routes())
    end
  end

  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes,
        endpoint: LLWeb.Endpoint,
        router: LLWeb.Router,
        statics: LLWeb.static_paths()
    end
  end

  @doc """
  When used, dispatch to the appropriate controller/live_view/etc.
  """
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
