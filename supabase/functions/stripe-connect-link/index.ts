/**
 * supabase/functions/stripe-connect-link/index.ts
 *
 * Generates a Stripe Connect onboarding link for a host to complete their account setup.
 *
 * Flow:
 * 1. Host clicks "Connect Stripe" in settings
 * 2. Frontend calls this function with stripeAccountId
 * 3. Returns an onboarding URL for the host to complete Stripe setup
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

// ---------------------------------------------------------------------------
// Stripe API helper
// ---------------------------------------------------------------------------

async function stripeRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message ?? "Stripe API error");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization") ?? "";
  const expectedKey = Deno.env.get("SUPABASE_functions_KEY");

  if (expectedKey && authHeader !== `Bearer ${expectedKey}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const {
      stripeAccountId,
      returnUrl,
      refreshUrl,
    } = await req.json() as {
      stripeAccountId: string;
      returnUrl: string;
      refreshUrl: string;
    };

    if (!stripeAccountId) {
      return Response.json({ error: "Missing stripeAccountId" }, { status: 400 });
    }

    // Create an Account Link for onboarding completion
    const accountLink = await stripeRequest(
      "POST",
      "account_links",
      {
        account: stripeAccountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      }
    ) as { url: string };

    return Response.json({
      url: accountLink.url,
    });

  } catch (error) {
    console.error("stripe-connect-link error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
});
