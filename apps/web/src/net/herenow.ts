/**
 * apps/web/src/net/herenow.ts — HereNow URL persistence helpers.
 *
 * linkHereNowUrl()  — validate + upsert a *.here.now URL to profiles
 * getHereNowUrl()   — read back the stored URL for a given user
 */

import { getSupabase } from "../auth/index.js";

const HERENOW_RE = /^https:\/\/[a-zA-Z0-9-]+\.here\.now(\/.*)?\.?$/;

/**
 * Validate the URL looks like a real here.now room link, then persist it
 * to profiles.herenow_url for the authenticated user.
 *
 * Throws a descriptive Error on validation failure or Supabase error.
 */
export async function linkHereNowUrl(userId: string, url: string): Promise<void> {
  const trimmed = url.trim();

  if (!trimmed) {
    throw new Error("Please enter a HereNow URL.");
  }

  if (!HERENOW_RE.test(trimmed)) {
    throw new Error(
      "URL must match https://<room>.here.now or https://<room>.here.now/<path>. " +
      "Copy it directly from your HereNow browser tab."
    );
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from("profiles")
    .update({ herenow_url: trimmed } as Record<string, unknown>)
    .eq("id", userId);

  if (error) {
    throw new Error(`Failed to save HereNow URL: ${error.message}`);
  }
}

/**
 * Returns the stored HereNow URL for a given user, or null if not set.
 */
export async function getHereNowUrl(userId: string): Promise<string | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("profiles")
    .select("herenow_url")
    .eq("id", userId)
    .single();

  if (error || !data) return null;
  return (data as Record<string, unknown>).herenow_url as string | null ?? null;
}
