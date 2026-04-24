defmodule LLWeb.Router do
  use LLWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :put_root_layout, {LLWeb.LayoutView, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", LLWeb do
    pipe_through :browser

    live "/", LibraryLive
    live "/library/:id", LibraryLive
    live "/updates", UpdatesLive
    live "/search", SearchLive
    live "/search/:source", SourceLive
    live "/extensions", ExtensionsLive
    live "/categories", CategoriesLive

    live "/reader", ReaderLiveS

    live "/series/:series_id", SeriesLive

    live "/series/:series_id/:chapter_id", ReaderLive

    get "/page/:chapter/:index", PageController, :page

    live "/routes", RoutesLive
    live "/status", StatusLive
  end

  # Other scopes may use custom stacks.
  scope "/api/", LLWeb do
    pipe_through :api

    get "/all.json", ApiController, :all
    get "/series/:series_id", ApiController, :series
    get "/series/:series_id/:chapter_id", ApiController, :chapter
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
