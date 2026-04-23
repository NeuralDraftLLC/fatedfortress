import { defineConfig, devices } from "@playwright/test";
import * as path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: path.resolve(process.cwd(), "e2e", ".env") });
loadDotenv();

const hasSupabase = !!(
  process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY
);

const webEnv = {
  VITE_E2E_PASSWORD_LOGIN: "true",
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL ?? "",
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY ?? "",
  VITE_R2_PUBLIC_URL: process.env.VITE_R2_PUBLIC_URL ?? "",
  VITE_GITHUB_CLIENT_ID: process.env.VITE_GITHUB_CLIENT_ID ?? "",
};

/**
 * E2E runs a production build + preview. Point VITE_* at a real dev Supabase project
 * (Auth email+password + Edge Functions + R2 + Stripe test keys configured).
 */
export default defineConfig({
  globalSetup: path.resolve(process.cwd(), "e2e/global-setup.ts"),
  testDir: "e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 360_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [["list"], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: hasSupabase
    ? {
        command: "cd apps/web && npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI,
        env: { ...process.env, ...webEnv, PATH: process.env.PATH! },
        timeout: 300_000,
      }
    : undefined,
});
