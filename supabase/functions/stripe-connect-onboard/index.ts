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
import { resolveAuth } from "../_shared/auth.ts";

function getStripeSecretKey(): string {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return key;
}

async function stripeRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${getStripeSecretKey()}`,
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

Deno.serve(async (req: Request) => {
  const auth = await resolveAuth(req);
  if (auth.kind !== "user") {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { userId } = await req.json() as { userId: string };

    if (!userId) {
      return Response.json({ error: "Missing userId" }, { status: 400 });
    }

    if (userId !== auth.user.id) {
      return Response.json({ error: "userId must match session" }, { status: 403 });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Fetch display_name from profiles (exists) and email from auth.users directly
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .single();

    const { data: authUser } = await supabase
      .from("auth.users")
      .select("email")
      .eq("id", userId)
      .single();

    // Use proper Stripe capability key syntax (no quoted keys)
    const accountParams: Record<string, string> = {
      type: "express",
      country: "US",
      "capabilities[card_payments]": "active",
      "capabilities[transfers]": "active",
    };

    // Email comes from auth.users, not profiles
    if (authUser?.email) {
      accountParams["email"] = authUser.email;
    }

    // display_name exists on profiles; use it for business name
    if (profile?.display_name) {
      accountParams["business_profile[name]"] = profile.display_name;
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
