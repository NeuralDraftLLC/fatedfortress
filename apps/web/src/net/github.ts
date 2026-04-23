/**
 * apps/web/src/net/github.ts — GitHub OAuth + API helpers.
 *
 * Sacred objects: Task, Submission, Decision
 *
 * Used by: settings.ts (OAuth onboarding), submit.ts (PR verification),
 * workers/verify-submission (PR existence check).
 */

import { getSupabase } from "../auth/index.js";

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const GITHUB_CLIENT_ID = import.meta.env["VITE_GITHUB_CLIENT_ID"] ?? "";
const GITHUB_REDIRECT_URI = `${window.location.origin}/github/callback`;

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

/**
 * Start GitHub OAuth flow. Redirects to GitHub.
 */
export function initiateGitHubOAuth(): void {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT_URI,
    scope: "repo read:user",
  });
  window.location.href = `https://github.com/login/oauth/authorize?${params}`;
}

/**
 * Exchange OAuth code for access token, store on profile.
 * Called from /github/callback route.
 */
export async function exchangeGitHubCode(code: string): Promise<string> {
  const { data, error } = await getSupabase()
    .functions
    .invoke("github-oauth", {
      body: { code, redirect_uri: GITHUB_REDIRECT_URI },
    });

  if (error || !data?.access_token) {
    throw new Error("GitHub OAuth failed");
  }

  // Store token on profile
  const { data: { user } } = await getSupabase().auth.getUser();
  if (user) {
    // Fetch GitHub profile to get username
    const ghProfile = await fetch(
      "https://api.github.com/user",
      { headers: { Authorization: `Bearer ${data.access_token}`, Accept: "application/vnd.github.v3+json" } }
    );
    if (ghProfile.ok) {
      const ghUser = await ghProfile.json() as { login: string };
      await getSupabase()
        .from("profiles")
        .update({ github_token: data.access_token, github_username: ghUser.login } as Record<string, unknown>)
        .eq("id", user.id);
    } else {
      await getSupabase()
        .from("profiles")
        .update({ github_token: data.access_token } as Record<string, unknown>)
        .eq("id", user.id);
    }
  }

  return data.access_token;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  owner: string;
  repo: string;
  branch: string;
}

export interface PRInfo {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  merged: boolean;
}

/**
 * Create a branch in a GitHub repository.
 */
export async function createBranch(
  token: string,
  repo: GitHubRepo,
  newBranch: string,
  baseBranch = "main"
): Promise<string> {
  // Get SHA of base branch
  const refRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/ref/heads/${baseBranch}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
    }
  );
  if (!refRes.ok) throw new Error(`GitHub API error: ${refRes.status}`);
  const { object: { sha } } = await refRes.json() as { object: { sha: string } };

  // Create new branch
  const createRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/refs`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
      body: JSON.stringify({
        ref: `refs/heads/${newBranch}`,
        sha,
      }),
    }
  );
  if (!createRes.ok) throw new Error(`Failed to create branch: ${createRes.status}`);
  return newBranch;
}

/**
 * Create a pull request.
 */
export async function createPR(
  token: string,
  repo: GitHubRepo,
  options: {
    title: string;
    body: string;
    head: string;
    base?: string;
  }
): Promise<PRInfo> {
  const res = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
      body: JSON.stringify({
        title: options.title,
        body: options.body,
        head: options.head,
        base: options.base ?? "main",
      }),
    }
  );
  if (!res.ok) throw new Error(`Failed to create PR: ${res.status}`);
  const pr = await res.json() as { number: number; html_url: string; title: string; state: string; merged: boolean };
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state === "open" ? "open" : "closed",
    merged: pr.merged,
  };
}

/**
 * Check if a PR exists and is accessible.
 * Used by VERIFY_SUBMISSION for 'pr' deliverable type.
 */
export async function checkPRExists(token: string, prUrl: string): Promise<PRInfo | null> {
  // Extract owner/repo/number from PR URL
  // e.g. https://github.com/owner/repo/pull/123
  const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;

  const [, owner, repo, number] = match;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
    }
  );

  if (!res.ok) return null;
  const pr = await res.json() as { number: number; html_url: string; title: string; state: string; merged: boolean };
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state === "open" ? "open" : "closed",
    merged: pr.merged,
  };
}

/**
 * Check if a Figma link is accessible.
 * Stub — real implementation requires Figma API token.
 */
export async function checkFigmaAccessible(_figmaUrl: string): Promise<boolean> {
  // TODO: implement with Figma API
  // GET https://api.figma.com/v1/files/{key}
  // Requires VITE_FIGMA_ACCESS_TOKEN env var
  return true;
}
