/**
 * supabase/functions/get-public-stats/index.ts
 *
 * Public (no JWT required) edge function that returns aggregate platform stats
 * for the landing page stat strip:
 *
 *   { open_task_count, total_paid_out_cents, contributor_count }
 *
 * Uses service role key (read-only queries on public-facing counts).
 * Cached for 60 seconds via Cache-Control header — cheap enough to call
 * on every landing page mount without hammering the DB.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Run three cheap count queries in parallel
    const [openTasksRes, paidOutRes, contributorRes] = await Promise.all([
      // open_task_count — tasks with status=open
      serviceClient
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("status", "open"),

      // total_paid_out_cents — sum of approved_payout on decisions
      serviceClient
        .from("decisions")
        .select("approved_payout.sum()")
        .eq("decision_reason", "great_work")
        .single(),

      // contributor_count — profiles that have ever claimed a task
      serviceClient
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .gt("review_count", 0),
    ]);

    const open_task_count       = openTasksRes.count ?? 0;
    const total_paid_out_cents  = (
      (paidOutRes.data as Record<string, unknown> | null)
        ?.approved_payout_sum as number
    ) ?? 0;
    const contributor_count     = contributorRes.count ?? 0;

    return new Response(
      JSON.stringify({ open_task_count, total_paid_out_cents, contributor_count }),
      {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type":  "application/json",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
        },
      },
    );
  } catch (err) {
    console.error("get-public-stats error:", err);
    return new Response(
      JSON.stringify({ open_task_count: 0, total_paid_out_cents: 0, contributor_count: 0 }),
      {
        status: 200, // return 200 with zeros so landing page never breaks
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      },
    );
  }
});
