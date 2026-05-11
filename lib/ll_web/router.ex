defmodule LLWeb.Router do
  use LLWeb, :router

  import LLWeb.UserAuth

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :put_root_layout, {LLWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :fetch_current_scope_for_user
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", LLWeb do
    pipe_through :browser

    get "/page/:chapter/:index", PageController, :page
  end

  # Other scopes may use custom stacks.
  scope "/api/", LLWeb do
    pipe_through :api

    get "/all.json", ApiController, :all
    get "/series/:series_id", ApiController, :series
    get "/series/:series_id/:chapter_id", ApiController, :chapter
  end

  scope "/", LLWeb do
    pipe_through [:browser, :require_authenticated_user]

    live_session :require_authenticated_user,
      on_mount: [{LLWeb.UserAuth, :require_authenticated}] do
      live "/user/settings", UserLive.Settings, :edit
    end

    post "/user/update-password", UserSessionController, :update_password
  end

  scope "/", LLWeb do
    pipe_through [:browser]

    live_session :current_user,
      on_mount: [{LLWeb.UserAuth, :mount_current_scope}] do
      live "/user/register", UserLive.Registration, :new
      live "/user/log-in", UserLive.Login, :new

      live "/", LibraryLive
      live "/library/c/:category/:m/:id", LibraryLive, :multi
      live "/library/c/:category/:id", LibraryLive
      live "/library/c/:category", LibraryLive
      live "/library/:m/:id", LibraryLive, :multi
      live "/library/:id", LibraryLive
      live "/updates", UpdatesLive
      live "/search", SearchLive
      live "/search/:source", SourceLive
      live "/extensions", ExtensionsLive
      live "/categories", CategoriesLive

      live "/reader", ReaderLiveS

      live "/series/:series_id", SeriesLive

      live "/series/:series_id/:chapter_id", ReaderLive

      live "/routes", RoutesLive
      live "/status", StatusLive
    end

    post "/user/log-in", UserSessionController, :create
    delete "/user/log-out", UserSessionController, :delete
  end

  # Enables LiveDashboard only for development
  #
  # If you want to use the LiveDashboard in production, you should put
  # it behind authentication and allow only admins to access it.
  # If your application does not have an admins-only section yet,
  # you can use Plug.BasicAuth to set up some basic authentication
  # as long as you are also using SSL (which you should anyway).
  if Mix.env() in [:dev, :test] do
    import Phoenix.LiveDashboard.Router

    scope "/" do
      pipe_through :browser

      live_dashboard "/dashboard", metrics: LLWeb.Telemetry
    end
  end
end
