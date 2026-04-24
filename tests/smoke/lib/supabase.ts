/**
 * tests/smoke/lib/supabase.ts
 * Creates a service-role Supabase client for tests.
 * Works with both Deno (esm.sh) and Node (@supabase/supabase-js).
 */

import { config } from "./config.ts";

// Dynamic import so this file is importable in both runtimes
let _createClient: (url: string, key: string) => SupabaseAdminClient;

try {
  // Node
  const mod = await import("@supabase/supabase-js");
  _createClient = mod.createClient;
} catch {
  // Deno
  const mod = await import("https://esm.sh/@supabase/supabase-js@2");
  _createClient = mod.createClient;
}

export type SupabaseAdminClient = ReturnType<typeof _createClient>;

export function createAdminClient(): SupabaseAdminClient {
  return _createClient(config.supabaseUrl, config.serviceRoleKey);
}
