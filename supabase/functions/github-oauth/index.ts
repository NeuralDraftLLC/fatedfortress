/**
 * supabase/functions/github-oauth/index.ts
 *
 * Exchanges a GitHub OAuth code for an access token using GitHub's
 * client-side flow. The client_secret never leaves the server.
 *
 * This is a backend-only OAuth exchange — we never expose the
 * client secret to the browser.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GitHubTokenError {
  error: string;
  error_description: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  // Verify caller is authenticated (edge functions invoke has anon key)
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const { code, redirect_uri } = await req.json() as {
      code: string;
      redirect_uri: string;
    };

    if (!code) {
      return new Response(JSON.stringify({ error: "code is required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // GitHub requires POST with form-encoded body
    const params = new URLSearchParams({
      client_id: Deno.env.get("GITHUB_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GITHUB_CLIENT_SECRET") ?? "",
      code,
      redirect_uri: redirect_uri ?? "",
    });

    const response = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const result = await response.json() as GitHubTokenResponse | GitHubTokenError;

    if (!response.ok || "error" in result) {
      const err = result as GitHubTokenError;
      console.error("GitHub OAuth error:", err.error, err.error_description);
      return new Response(JSON.stringify({ error: err.error_description ?? "OAuth failed" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      access_token: (result as GitHubTokenResponse).access_token,
      token_type: (result as GitHubTokenResponse).token_type,
      scope: (result as GitHubTokenResponse).scope,
    }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("github-oauth error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
