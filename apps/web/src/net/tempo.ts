/**
 * net/tempo.ts — Tempo stablecoin payment client for paid rooms.
 *
 * Flow:
 *   1. User clicks PAY on a paid room
 *   2. POST /tempo/intent { amount, hostWallet, ffWallet }
 *   3. Redirect to Tempo payment page
 *   4. On success → here.now edge function issues JWT cookie
 *   5. here.now edge function: 80% to host, 20% to FF (atomic split)
 *
 * FF wallet address: configured via VITE_TEMPO_WALLET env var.
 * Host wallet: stored in room Y.js doc metadata.
 */

import type { PaymentIntent } from "@fatedfortress/protocol";

const PLATFORM_FEE_BPS = 2000; // 20%

export interface SplitResult {
  hostAmount: number;
  platformAmount: number;
  hostBasisPoints: 8000;
  platformBasisPoints: 2000;
}

export function calculateSplit(amount: number, type: PaymentIntent["type"]): SplitResult {
  const platformAmount = Math.floor(amount * PLATFORM_FEE_BPS / 10000);
  const hostAmount = amount - platformAmount;
  const hostBps = 8000 as const;
  const platformBps = 2000 as const;
  return {
    hostAmount,
    platformAmount,
    hostBasisPoints: hostBps,
    platformBasisPoints: platformBps,
  };
}

export interface SplitModalOptions {
  amount: number;
  type: PaymentIntent["type"];
  hostAddress: string;
  platformAddress: string;
  onConfirm: (intent: PaymentIntent) => void;
  onCancel: () => void;
}

export function showSplitModal(options: SplitModalOptions): void {
  const split = calculateSplit(options.amount, options.type);
  const overlay = document.createElement("div");
  overlay.className = "split-modal-overlay";

  overlay.innerHTML = `
    <div class="split-modal">
      <h3>Confirm Payment</h3>
      <div class="split-row">
        <span>Total amount:</span>
        <span>$${(options.amount / 100).toFixed(2)} USDC</span>
      </div>
      <div class="split-row">
        <span>To host:</span>
        <span>$${(split.hostAmount / 100).toFixed(2)} USDC (${split.hostBasisPoints / 100}%)</span>
      </div>
      <div class="split-row">
        <span>Platform fee:</span>
        <span>$${(split.platformAmount / 100).toFixed(2)} USDC (${split.platformBasisPoints / 100}%)</span>
      </div>
      <div class="split-row">
        <span>Type:</span>
        <span>${options.type.replace("_", " ")}</span>
      </div>
      <div class="split-actions">
        <button class="split-btn-cancel">Cancel</button>
        <button class="split-btn-confirm">Confirm</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector(".split-btn-cancel")?.addEventListener("click", () => {
    overlay.remove();
    options.onCancel();
  });

  overlay.querySelector(".split-btn-confirm")?.addEventListener("click", () => {
    overlay.remove();
    const intent: PaymentIntent = {
      amount: options.amount,
      currency: "USDC",
      destination: options.hostAddress as any,
      platformAddress: options.platformAddress as any,
      memo: `${options.type} payment`,
      split,
      type: options.type,
    };
    options.onConfirm(intent);
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.remove();
      options.onCancel();
    }
  });
}

export interface ExecutePaymentOptions {
  intent: PaymentIntent;
  onSuccess: () => void;
  onError: (error: string) => void;
}

/**
 * Executes a payment via the Tempo stablecoin API.
 *
 * The VITE_TEMPO_API_URL env var controls the endpoint:
 *   - In development: http://localhost:8787 (Wrangler dev)
 *   - In production: https://api.tempo.fatedfortress.com
 *
 * If no API key is configured, simulates success for development.
 */
export async function executePayment(options: ExecutePaymentOptions): Promise<void> {
  const { intent } = options;
  const tempoApiUrl = (import.meta.env.VITE_TEMPO_API_URL as string | undefined)
    ?? "https://api.tempo.fatedfortress.com";
  const tempoApiKey = import.meta.env.VITE_TEMPO_API_KEY as string | undefined;

  // Development mode: no API key configured — simulate success
  if (!tempoApiKey || tempoApiKey === "dev") {
    console.warn("[tempo] No API key — simulating payment success");
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    window.dispatchEvent(new CustomEvent("tempo:payment_success", {
      detail: { intent, simulated: true }
    }));
    options.onSuccess();
    return;
  }

  try {
    const response = await fetch(`${tempoApiUrl}/v1/payment_intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tempoApiKey}`,
        "X-Client": "fatedfortress",
      },
      body: JSON.stringify({
        amount: intent.amount,
        currency: intent.currency,
        destination: intent.destination,
        memo: intent.memo,
        split: intent.split,
      }),
    });

    if (!response.ok) {
      let message = `Tempo error: ${response.status}`;
      try {
        const errData = await response.json() as { message?: string };
        if (errData?.message) message = errData.message;
      } catch {}
      throw new Error(message);
    }

    const data = await response.json() as {
      paymentUrl?: string;
      transactionHash?: string;
      status?: string;
    };

    if (data.paymentUrl) {
      // Redirect to Tempo hosted payment page
      // On return, the here.now edge function will set a session cookie
      // and redirect back to the room
      window.location.href = data.paymentUrl;
    } else if (data.transactionHash || data.status === "confirmed") {
      // Payment was instant (sufficient balance / pre-authorized)
      window.dispatchEvent(new CustomEvent("tempo:payment_success", {
        detail: { intent, transactionHash: data.transactionHash }
      }));
      options.onSuccess();
    } else {
      throw new Error("Unexpected Tempo response: no paymentUrl or transactionHash");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Payment failed";
    options.onError(message);
  }
}
