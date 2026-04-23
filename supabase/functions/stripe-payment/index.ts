/**
 * supabase/functions/stripe-payment/index.ts
 *
 * Stripe Connect payment handler for the Fated Fortress platform.
 *
 * Payment Flow:
 * 1. create (on claim):  Create PaymentIntent with manual capture + transfer to platform
 * 2. capture (on approve): Capture the PaymentIntent, with application_fee
 * 3. cancel (on reject/expire): Cancel the PaymentIntent
 * 4. refund (on refund request): Refund a captured payment
 *
 * Platform fee: 10% (1000 bps) deducted as application_fee_amount
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveAuth } from "../_shared/auth.ts";

const PLATFORM_FEE_BPS = 1000; // 10%

function getStripeSecretKey(): string {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return key;
}

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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const auth = await resolveAuth(req);
  if (auth.kind === "none") {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { action, ...params } = await req.json();

    switch (action) {
      case "create": {
        // Create PaymentIntent with manual capture for later capture on approval
        const {
          amount,
          connectedAccountId,
          taskId,
          submissionId,
          contributorStripeAccountId,
        } = params as {
          amount: number;
          connectedAccountId?: string;
          taskId: string;
          submissionId: string;
          contributorStripeAccountId?: string;
        };

        if (!amount || amount <= 0) {
          return Response.json({ success: false, error: "Invalid amount" }, { status: 400 });
        }

        const platformFee = Math.round(amount * (PLATFORM_FEE_BPS / 10000));

        // Build PaymentIntent creation params
        const paymentIntentParams: Record<string, string> = {
          amount: amount.toString(),
          currency: "usd",
          "capture_method": "manual",
          "metadata[taskId]": taskId,
          "metadata[submissionId]": submissionId,
          "metadata[platformFee]": platformFee.toString(),
        };

        // If host has connected account, transfer to them after capture
        if (connectedAccountId) {
          paymentIntentParams["transfer_data[destination]"] = connectedAccountId;
          // application_fee_amount is the platform fee we keep
          paymentIntentParams["application_fee_amount"] = platformFee.toString();
        }

        // Create PaymentIntent
        const paymentIntent = await stripeRequest(
          "POST",
          "payment_intents",
          paymentIntentParams
        ) as { id: string; client_secret: string };

        // Store PaymentIntent ID in Supabase for later capture
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        // Update submission with payment intent
        await supabase
          .from("submissions")
          .update({ payment_intent_id: paymentIntent.id } as Record<string, unknown>)
          .eq("id", submissionId);

        return Response.json({
          success: true,
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret,
        });
      }

      case "capture": {
        // Capture a previously created PaymentIntent on task approval
        const {
          paymentIntentId,
          amount,
          platformFee,
          connectedAccountId,
          contributorStripeAccountId,
          submissionId,
          taskId,
        } = params as {
          paymentIntentId?: string;
          amount: number;
          platformFee: number;
          connectedAccountId?: string;
          contributorStripeAccountId?: string;
          submissionId?: string;
          taskId?: string;
        };

        if (!paymentIntentId) {
          return Response.json({ success: false, error: "Missing paymentIntentId" }, { status: 400 });
        }

        // Build capture params
        const captureParams: Record<string, string> = {
          "capture_method": "manual", // Already set, but explicit
        };

        // If host has connected account, set transfer_data for the capture
        if (connectedAccountId) {
          captureParams["transfer_data[destination]"] = connectedAccountId;
          captureParams["application_fee_amount"] = platformFee.toString();
        }

        const paymentIntent = await stripeRequest(
          "POST",
          `payment_intents/${paymentIntentId}/capture`,
          captureParams
        ) as { id: string; status: string; transfer_group?: string };

        return Response.json({
          success: true,
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        });
      }

      case "cancel": {
        // Cancel a PaymentIntent (on rejection or claim expiration)
        const { paymentIntentId } = params as { paymentIntentId?: string };

        if (!paymentIntentId) {
          return Response.json({ success: false, error: "Missing paymentIntentId" }, { status: 400 });
        }

        const paymentIntent = await stripeRequest(
          "POST",
          `payment_intents/${paymentIntentId}/cancel`
        ) as { id: string; status: string };

        return Response.json({
          success: true,
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
        });
      }

      case "refund": {
        // Refund a captured payment
        const { paymentIntentId, amount } = params as {
          paymentIntentId?: string;
          amount?: number;
        };

        if (!paymentIntentId) {
          return Response.json({ success: false, error: "Missing paymentIntentId" }, { status: 400 });
        }

        const refundParams: Record<string, string> = {};
        if (amount) {
          refundParams["amount"] = amount.toString();
        }

        const refund = await stripeRequest(
          "POST",
          "refunds",
          { payment_intent: paymentIntentId, ...refundParams }
        ) as { id: string; status: string };

        return Response.json({
          success: true,
          refundId: refund.id,
          status: refund.status,
        });
      }

      case "create_transfer": {
        // Direct transfer to contributor's Connect account (after capture)
        const {
          amount,
          destinationAccountId,
          taskId,
        } = params as {
          amount: number;
          destinationAccountId?: string;
          taskId: string;
        };

        if (!destinationAccountId) {
          return Response.json({ success: false, error: "Missing destinationAccountId" }, { status: 400 });
        }

        const platformFee = Math.round(amount * (PLATFORM_FEE_BPS / 10000));
        const transferAmount = amount - platformFee;

        const transfer = await stripeRequest(
          "POST",
          "transfers",
          {
            amount: transferAmount.toString(),
            currency: "usd",
            destination: destinationAccountId,
            "metadata[taskId]": taskId,
            description: `Payout for task ${taskId}`,
          }
        ) as { id: string; destination: string; amount: number };

        return Response.json({
          success: true,
          transferId: transfer.id,
          amount: transfer.amount,
        });
      }

      default:
        return Response.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    console.error("stripe-payment error:", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 }
    );
  }
});
