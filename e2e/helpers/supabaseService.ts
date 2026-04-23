import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function getServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in e2e/.env");
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function setProfileRole(
  supabase: SupabaseClient,
  userId: string,
  role: "host" | "contributor"
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update({ role } as Record<string, unknown>)
    .eq("id", userId);
  if (error) throw new Error(`setProfileRole: ${error.message}`);
}

export async function makeProjectTasksPublic(
  supabase: SupabaseClient,
  projectId: string
): Promise<void> {
  const { error } = await supabase
    .from("tasks")
    .update({ task_access: "public" } as Record<string, unknown>)
    .eq("project_id", projectId);
  if (error) throw new Error(`makeProjectTasksPublic: ${error.message}`);
}

export interface TaskRow {
  id: string;
  payout_min: string | number;
  payout_max: string | number;
  project_id: string;
}

export async function getTaskById(
  supabase: SupabaseClient,
  taskId: string
): Promise<TaskRow | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, payout_min, payout_max, project_id")
    .eq("id", taskId)
    .single();
  if (error) return null;
  return data as TaskRow;
}

export async function getLatestSubmissionForTask(
  supabase: SupabaseClient,
  taskId: string
): Promise<{
  id: string;
  task_id: string;
  asset_url: string;
  payment_intent_id: string | null;
} | null> {
  const { data, error } = await supabase
    .from("submissions")
    .select("id, task_id, asset_url, payment_intent_id")
    .eq("task_id", taskId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as {
    id: string;
    task_id: string;
    asset_url: string;
    payment_intent_id: string | null;
  };
}
