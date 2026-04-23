/**
 * Shared auth helpers for Supabase Edge Functions.
 * supabase-js sends the user's access token in Authorization when a session exists;
 * server-side clients may send the service role key in Authorization.
 */
import { createClient, type User, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export type ResolvedAuth =
  | { kind: "user"; user: User; token: string }
  | { kind: "service" }
  | { kind: "none" };

/** Resolve caller from Authorization: user JWT, or service role key, or none. */
export async function resolveAuth(req: Request): Promise<ResolvedAuth> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return { kind: "none" };
  const token = m[1];
  if (serviceKey && token === serviceKey) {
    return { kind: "service" };
  }
  if (!supabaseUrl || !anonKey) {
    return { kind: "none" };
  }
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { kind: "none" };
  }
  return { kind: "user", user, token };
}

export function serviceRoleClient(): SupabaseClient {
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  return createClient(supabaseUrl, serviceKey);
}
