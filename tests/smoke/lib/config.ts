/**
 * tests/smoke/lib/config.ts
 * Loads env vars — works with Deno (reads .env via --allow-read) and Node (dotenv).
 */

let env: Record<string, string | undefined>;

if (typeof Deno !== "undefined") {
  // Deno: load .env manually
  try {
    const raw = await Deno.readTextFile(new URL("../.env", import.meta.url));
    env = Object.fromEntries(
      raw
        .split("\n")
        .filter(l => l.trim() && !l.startsWith("#"))
        .map(l => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, "")];
        })
    );
    // Merge with real env so explicit exports win
    for (const [k, v] of Object.entries(env)) {
      if (!Deno.env.get(k)) Deno.env.set(k, v ?? "");
    }
    env = { ...env, ...Object.fromEntries(
      Object.keys(env).map(k => [k, Deno.env.get(k)])
    )};
  } catch {
    env = {};
  }
  // Absorb Deno env
  for (const key of [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY",
    "STRIPE_SECRET_KEY", "TEST_HOST_ID", "TEST_CONTRIBUTOR_ID",
  ]) {
    env[key] = env[key] ?? Deno.env.get(key);
  }
} else {
  // Node: try dotenv
  try {
    const { config: dotenv } = await import("dotenv");
    dotenv({ path: new URL("../.env", import.meta.url).pathname });
  } catch { /* dotenv not installed — rely on process.env */ }
  env = process.env as Record<string, string | undefined>;
}

function required(key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const config = {
  supabaseUrl:       required("SUPABASE_URL"),
  serviceRoleKey:    required("SUPABASE_SERVICE_ROLE_KEY"),
  anonKey:           required("SUPABASE_ANON_KEY"),
  stripeKey:         required("STRIPE_SECRET_KEY"),
  testHostId:        required("TEST_HOST_ID"),
  testContributorId: required("TEST_CONTRIBUTOR_ID"),
  quiet:             (env["SMOKE_QUIET"] ?? "") === "true",
};
