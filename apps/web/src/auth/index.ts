/**
 * apps/web/src/auth/index.ts — Supabase Auth wrapper.
 *
 * Replaces anonymous Ed25519 keypair as primary identity.
 * Ed25519 keys are retained for receipt signing and audit trail only.
 */

import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url     = import.meta.env.VITE_SUPABASE_URL as string;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
    if (!url || !anonKey) {
      throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set");
    }
    _client = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/** Sign in with email magic link */
export async function signInWithEmailMagicLink(email: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw error;
}

/** Email + password (requires Email provider with password enabled in Supabase; used for E2E). */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/** Sign in with Google OAuth */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await getSupabase().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw error;
}

/** Sign out the current user */
export async function signOut(): Promise<void> {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

/** Get the currently authenticated user (null if not signed in) */
export async function getCurrentUser(): Promise<User | null> {
  const { data } = await getSupabase().auth.getUser();
  return data.user;
}

/** Get the current session synchronously (may be null) */
export function getCurrentSession() {
  return getSupabase().auth.getSession();
}

/** Subscribe to auth state changes (id token changes, sign in/out) */
export function onAuthStateChange(callback: (event: string, session: any) => void) {
  return getSupabase().auth.onAuthStateChange(callback);
}

// ---------------------------------------------------------------------------
// Profile helpers
// ---------------------------------------------------------------------------

export interface Profile {
  id: string;
  display_name: string;
  role: "host" | "contributor";
  github_username: string | null;
  avatar_url: string | null;
  review_reliability: number;
  approval_rate: number;
  avg_revision_count: number;
  avg_response_time_minutes: number;
  total_approved: number;
  total_submitted: number;
  total_rejected: number;
}

/** Fetch the profile for the current authenticated user */
export async function getMyProfile(): Promise<Profile | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const { data } = await getSupabase()
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  return data as Profile | null;
}

/** Fetch a profile by user ID */
export async function getProfile(userId: string): Promise<Profile | null> {
  const { data } = await getSupabase()
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  return data as Profile | null;
}

/** Update the current user's profile */
export async function updateMyProfile(updates: Partial<Profile>): Promise<Profile> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  const { data, error } = await getSupabase()
    .from("profiles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", user.id)
    .select()
    .single();
  if (error) throw error;
  return data as Profile;
}

// ---------------------------------------------------------------------------
// Role upsert — called once after first sign-in
// ---------------------------------------------------------------------------

/**
 * Write `role` to profiles for the current user, but ONLY if the existing
 * profile row has role = null (i.e. never overwrite a role already set).
 *
 * Safe to call on every sign-in; idempotent for existing users.
 */
export async function upsertProfileRole(
  role: "host" | "contributor"
): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;

  const supabase = getSupabase();

  // Check existing role first — never overwrite
  const { data: existing } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .single();

  // Profile doesn't exist yet → insert with role
  if (!existing) {
    await supabase.from("profiles").insert({
      id:           user.id,
      display_name: user.email?.split("@")[0] ?? "Anonymous",
      role,
      review_reliability:        1.0,
      approval_rate:             1.0,
      avg_revision_count:        0,
      avg_response_time_minutes: 0,
      total_approved:            0,
      total_submitted:           0,
      total_rejected:            0,
    });
    return;
  }

  // Profile exists but role not yet set → patch it
  if (!existing.role) {
    await supabase
      .from("profiles")
      .update({ role, updated_at: new Date().toISOString() })
      .eq("id", user.id);
  }
  // If role is already set → no-op (never overwrite)
}
