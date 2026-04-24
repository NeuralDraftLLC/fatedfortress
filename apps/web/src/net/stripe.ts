import { loadStripe, Stripe } from "@stripe/stripe-js";

let stripePromise: Promise<Stripe | null> | null = null;

export async function getStripe(): Promise<Stripe> {
  if (!stripePromise) {
    const pk = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!pk) {
      throw new Error("Stripe publishable key is not configured");
    }
    stripePromise = loadStripe(pk);
  }

  const stripe = await stripePromise;
  if (!stripe) {
    throw new Error("Failed to initialize Stripe.js");
  }

  return stripe;
}
