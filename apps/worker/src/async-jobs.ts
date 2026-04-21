/**
 * apps/worker/src/async-jobs.ts
 *
 * PRIORITY 2 · Multimodal async jobs (Task 8)
 *
 * Manages async generation jobs that return job_ids for polling.
 * Key design: the API key is captured at registration time — if the user removes
 * their key before the job completes, the job fails with a clear user-facing error.
 *
 * Only one job per requestId at a time (enforced by Map semantics).
 *
 * Flow:
 *   registerAsyncJob(requestId, provider, apiKey, jobId)
 *     → starts polling
 *   onJobDone(requestId, result)
 *     → called by poll loop when job completes
 *   cancelAsyncJobsForRequest(requestId)
 *     → called on ABORT_GENERATE (Task 8.5)
 *   getJobResult(requestId)
 *     → returns the resolved output for the UI
 */

import type { ProviderId } from "@fatedfortress/protocol";
import type { AdapterYield } from "@fatedfortress/protocol";
import { FFError } from "@fatedfortress/protocol";

// ── Types ──────────────────────────────────────────────────────────────────────

interface AsyncJob {
  requestId: string;
  provider: ProviderId;
  apiKey: string; // captured at registration — stable even if user removes key later
  jobId: string;
  jobUrl: string;
  status: "pending" | "done" | "error";
  result: AdapterYield[] | null; // accumulated yields
  error: string | null;
  pollCount: number;
  abortController: AbortController;
  resolveOutput: ((yields: AdapterYield[]) => void) | null;
  outputPromise: Promise<AdapterYield[]>;
}

// ── State ──────────────────────────────────────────────────────────────────────

const jobs = new Map<string, AsyncJob>();

// ── Job Polling ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 60; // ~2 min for most async jobs

async function pollJob(job: AsyncJob): Promise<void> {
  try {
    const res = await fetch(job.jobUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${job.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: job.abortController.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new FFError("JOB_POLL_FAILED", `Poll failed (${res.status}): ${text}`);
    }

    const data = await res.json() as {
      status: "pending" | "succeeded" | "failed";
      output?: AdapterYield[];
      error?: { message: string };
    };

    if (data.status === "succeeded") {
      job.status = "done";
      job.result = data.output ?? [];
      job.resolveOutput?.(job.result!);
      return;
    }

    if (data.status === "failed") {
      job.status = "error";
      job.error = data.error?.message ?? "Unknown job failure";
      job.resolveOutput?.([]);
      return;
    }

    // still pending
    job.pollCount++;
    if (job.pollCount >= MAX_POLL_ATTEMPTS) {
      job.status = "error";
      job.error = "Job timed out after maximum poll attempts";
      job.resolveOutput?.([]);
      return;
    }

    // Schedule next poll
    setTimeout(() => { void pollJob(job); }, POLL_INTERVAL_MS);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      job.status = "error";
      job.error = "Job was cancelled";
      return;
    }
    job.status = "error";
    job.error = (err as Error).message ?? "Unknown polling error";
    job.resolveOutput?.([]);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Register an async job for a given requestId.
 * Key is captured HERE — if the user removes their key before the job finishes,
 * the error surfaced will be clear and user-facing.
 *
 * @throws FFError if the key is missing at registration time (not at poll time)
 */
export function registerAsyncJob(
  requestId: string,
  provider: ProviderId,
  apiKey: string,
  jobId: string,
  jobUrl: string
): Promise<AdapterYield[]> {
  if (!apiKey || apiKey.trim() === "") {
    throw new FFError(
      "KEY_MISSING",
      `Your ${provider} key was removed before the job could start. Add your key to continue.`
    );
  }

  if (jobs.has(requestId)) {
    // Safety: cancel any existing job for this requestId
    cancelAsyncJobsForRequest(requestId);
  }

  let resolveOutput: ((yields: AdapterYield[]) => void) | null = null;
  const outputPromise = new Promise<AdapterYield[]>((res) => {
    resolveOutput = res;
  });

  const job: AsyncJob = {
    requestId,
    provider,
    apiKey,
    jobId,
    jobUrl,
    status: "pending",
    result: null,
    error: null,
    pollCount: 0,
    abortController: new AbortController(),
    resolveOutput,
    outputPromise,
  };

  jobs.set(requestId, job);

  // Start polling immediately
  void pollJob(job);

  return outputPromise;
}

/** Returns the accumulated yields for a completed job, or waits for it. */
export async function getJobResult(requestId: string): Promise<AdapterYield[]> {
  const job = jobs.get(requestId);
  if (!job) return [];
  return job.outputPromise;
}

/** Cancels an in-flight async job. Called by ABORT_GENERATE in router.ts (Task 8.5). */
export function cancelAsyncJobsForRequest(requestId: string): void {
  const job = jobs.get(requestId);
  if (!job) return;
  job.abortController.abort();
  jobs.delete(requestId);
}

/** Returns true if there is an active (non-terminal) job for this requestId. */
export function hasActiveJob(requestId: string): boolean {
  const job = jobs.get(requestId);
  return job !== undefined && job.status === "pending";
}
