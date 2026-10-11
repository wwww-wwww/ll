defmodule LLWeb.AnilistAuthController do
  use LLWeb, :controller

  alias LL.Repo

  @authorize_url "https://anilist.co/api/v2/oauth/authorize"
  @token_url "https://anilist.co/api/v2/oauth/token"

  defp config(key), do: Application.get_env(:ll, :anilist)[key]
  defp redirect_uri(), do: url(~p"/user/anilist/callback")

  def connect(conn, _params) do
    if is_nil(config(:client_id)) do
      conn
      |> put_flash(:error, "Anilist client is not configured")
      |> redirect(to: ~p"/user/settings")
    else
      state = :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)

      query =
        URI.encode_query(%{
          client_id: config(:client_id),
          redirect_uri: redirect_uri(),
          response_type: "code",
          state: state
        })

      conn
      |> put_session(:anilist_state, state)
      |> redirect(external: "#{@authorize_url}?#{query}")
    end
  end

  def callback(conn, %{"code" => code, "state" => state}) do
    expected = get_session(conn, :anilist_state)
    conn = delete_session(conn, :anilist_state)

    with true <- is_binary(expected) and Plug.Crypto.secure_compare(expected, state),
         {:ok, token} <- exchange(code),
         {:ok, _} <-
           conn.assigns.current_scope.user
           |> Ecto.Changeset.change(%{anilist_key: token})
           |> Repo.update() do
      conn
      |> put_flash(:info, "Anilist connected")
      |> redirect(to: ~p"/user/settings")
    else
      err ->
        LL.Message.error(err)

        conn
        |> put_flash(:error, "Anilist authorization failed")
        |> redirect(to: ~p"/user/settings")
    end
  end

  def callback(conn, _params) do
    conn
    |> put_flash(:error, "Anilist authorization was denied")
    |> redirect(to: ~p"/user/settings")
  end

  defp exchange(code) do
    body =
      Jason.encode!(%{
        grant_type: "authorization_code",
        client_id: config(:client_id),
        client_secret: config(:client_secret),
        redirect_uri: redirect_uri(),
        code: code
      })

    with {:ok, %{status_code: 200, body: body}} <-
           HTTPoison.post(
             @token_url,
             body,
             [{"Accept", "application/json"}, {"Content-Type", "application/json"}],
             recv_timeout: 30000
           ),
         {:ok, %{"access_token" => token}} <- Jason.decode(body) do
      {:ok, token}
    else
      err -> {:error, err}
    end
  end
end
