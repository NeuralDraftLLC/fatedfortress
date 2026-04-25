/**
 * supabase/functions/get-stripe-status/index.ts
 *
 * Returns the live Stripe Connect account status for the authenticated host.
 * Called from settings.ts on mount to show CHARGES_ENABLED / PAYOUTS_ENABLED / PENDING chips.
 *
 * GET (no body required) — user identity resolved from JWT.
 *
 * Response:
 * {
 *   charges_enabled:   boolean,
 *   payouts_enabled:   boolean,
 *   details_submitted: boolean,
 * }
 */

import { resolveAuth, serviceRoleClient } from "../_shared/auth.ts";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-id",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
  }

  const admin = serviceRoleClient();

  // ── Read stripe_account_id from profiles ────────────────────────────────
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("stripe_account_id, role")
    .eq("id", auth.user.id)
    .single();

  if (profErr || !profile) {
    return Response.json({ error: "Profile not found" }, { status: 404, headers: CORS });
  }

  const p = profile as { stripe_account_id: string | null; role: string };

  if (p.role !== "host") {
    return Response.json({ error: "Only hosts have Stripe Connect accounts" }, { status: 403, headers: CORS });
  }

  if (!p.stripe_account_id) {
    // Not yet connected — return all-false so settings.ts can show the "not connected" state
    return Response.json(
      { charges_enabled: false, payouts_enabled: false, details_submitted: false },
      { headers: CORS }
    );
  }

  // ── Fetch account object from Stripe ─────────────────────────────────────
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/accounts/${encodeURIComponent(p.stripe_account_id)}`,
      {
        headers: {
          Authorization: `Bearer ${Deno.env.get("STRIPE_SECRET_KEY")}`,
        },
        signal: AbortSignal.timeout(8000),
      }
    );

    if (!res.ok) {
      const err = await res.json() as Record<string, unknown>;
      console.error("get-stripe-status: Stripe API error", err);
      return Response.json(
        { error: "stripe_api_error", message: (err.error as Record<string, string>)?.message ?? "Stripe error" },
        { status: 502, headers: CORS }
      );
    }

    const account = await res.json() as {
      charges_enabled:   boolean;
      payouts_enabled:   boolean;
      details_submitted: boolean;
    };

    return Response.json(
      {
        charges_enabled:   account.charges_enabled   ?? false,
        payouts_enabled:   account.payouts_enabled   ?? false,
        details_submitted: account.details_submitted ?? false,
      },
      { headers: CORS }
    );
  } catch (e) {
    console.error("get-stripe-status: fetch error", e);
    return Response.json(
      { error: "network_error", message: "Could not reach Stripe" },
      { status: 503, headers: CORS }
    );
  }
});
