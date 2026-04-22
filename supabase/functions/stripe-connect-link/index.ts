/**
 * supabase/functions/stripe-connect-link/index.ts
 *
 * Generates a Stripe Connect onboarding link for a host to complete their account setup.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getStripeSecretKey(): string {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return key;
}

function isFunctionAuthorized(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const token = m[1];
  const allowed = [
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    Deno.env.get("SUPABASE_ANON_KEY"),
    Deno.env.get("SUPABASE_functions_KEY"),
  ].filter((v): v is string => Boolean(v));
  return allowed.includes(token);
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
  if (!isFunctionAuthorized(req)) {
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
