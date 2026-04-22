/**
 * supabase/functions/stripe-connect-onboard/index.ts
 *
 * Creates a Stripe Connect account for a host and returns the account ID.
 * This is called when a host first connects their Stripe account.
 *
 * Account type: Express (recommended for most platforms)
 * Country: US (can be configured)
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
    const { userId } = await req.json() as { userId: string };

    if (!userId) {
      return Response.json({ error: "Missing userId" }, { status: 400 });
    }

    // Get user profile for email/name
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: profile } = await supabase
      .from("profiles")
      .select("id, email, full_name")
      .eq("id", userId)
      .single();

    // Create Express Connect account
    const accountParams: Record<string, string> = {
      type: "express",
      country: "US",
      capabilities["card_payments]": "active",
      capabilities["transfers]": "active",
    };

    // Add email if available for the account
    if (profile?.email) {
      accountParams["email"] = profile.email;
    }

    // Add business profile if name is available
    if (profile?.full_name) {
      accountParams["business_profile[name]"] = profile.full_name;
    }

    const account = await stripeRequest(
      "POST",
      "accounts",
      accountParams
    ) as { id: string; email?: string };

    return Response.json({
      stripeAccountId: account.id,
      email: account.email,
    });

  } catch (error) {
    console.error("stripe-connect-onboard error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
});
