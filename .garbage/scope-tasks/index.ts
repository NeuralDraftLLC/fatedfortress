/**
 * supabase/functions/scope-tasks/index.ts  — TOMBSTONE
 *
 * This function is DEPRECATED and no longer an active HTTP endpoint.
 *
 * The scoping logic (runScope, ScopeIntent, ScopedTask, ScopeResult) has been
 * extracted to supabase/functions/_shared/scope.ts.
 *
 * The sole active entry point for project scoping is:
 *   supabase/functions/create-and-scope-project/index.ts
 *
 * This file remains in the repo only so that Supabase deploy does not leave a
 * stale live function. All HTTP calls receive 410 Gone.
 * Re-exports are provided below so any compile-time imports from this path
 * continue to resolve without errors during the migration window.
 */

// Re-export from canonical location so existing import() calls compile.
export { runScope, ScopeIntent, ScopedTask, ScopeResult } from "../_shared/scope.ts";
export type { ScopeIntent, ScopedTask, ScopeResult };

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "Gone",
      message:
        "scope-tasks is deprecated. Use create-and-scope-project instead.",
    }),
    {
      status: 410,
      headers: { "Content-Type": "application/json" },
    }
  )
);
