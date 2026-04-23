import { createClient } from "@supabase/supabase-js";
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";

import { setProfileRole } from "./helpers/supabaseService";

loadDotenv({ path: path.resolve(process.cwd(), "e2e", ".env") });
loadDotenv();

async function ensureUser(
  supabase: ReturnType<typeof createClient>,
  email: string,
  password: string
) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (data.user) return data.user;

  const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  const found = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (found) return found;

  if (error && /already|registered|exists|duplicate/i.test(String(error.message))) {
    throw new Error(`E2E user ${email} missing from list after duplicate error`);
  }
  throw new Error(`Could not create user ${email}: ${error?.message ?? "unknown"}`);
}

/**
 * One-time: ensure E2E users exist (email+password) and roles. Safe to re-run.
 */
export default async function globalSetup() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hostEmail = process.env.E2E_HOST_EMAIL;
  const hostPassword = process.env.E2E_HOST_PASSWORD;
  const contEmail = process.env.E2E_CONTRIBUTOR_EMAIL;
  const contPassword = process.env.E2E_CONTRIBUTOR_PASSWORD;

  if (!url || !key || !hostEmail || !hostPassword || !contEmail || !contPassword) {
    // eslint-disable-next-line no-console
    console.warn(
      "e2e/global-setup: skipping user seed (set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, E2E_* env in e2e/.env)"
    );
    return;
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const host = await ensureUser(supabase, hostEmail, hostPassword);
  const cont = await ensureUser(supabase, contEmail, contPassword);
  await setProfileRole(supabase, host.id, "host");
  await setProfileRole(supabase, cont.id, "contributor");

  const acct = process.env.E2E_HOST_STRIPE_CONNECT_ACCOUNT;
  if (acct) {
    await supabase
      .from("profiles")
      .update({ stripe_account_id: acct } as Record<string, unknown>)
      .eq("id", host.id);
  }
}
