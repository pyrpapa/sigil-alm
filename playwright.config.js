import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// Locally, load E2E_EMAIL / E2E_PASSWORD (and the Supabase keys) from the
// git-ignored .env.local, so tests run without typing credentials each time.
// In CI the file doesn't exist; GitHub secrets provide the same variables.
if (existsSync('.env.local')) process.loadEnvFile('.env.local')

// By default, tests start the local dev server and run against it.
// Set BASE_URL to test a deployed site instead, e.g. https://sigil-alm.vercel.app
const baseURL = process.env.BASE_URL || 'http://localhost:5173'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No automatic retries: a test that only passes on retry is flaky, and in a
  // validation context a flaky result is something to investigate, not hide.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: 'npm run dev -- --port 5173 --strictPort',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
      },
})
