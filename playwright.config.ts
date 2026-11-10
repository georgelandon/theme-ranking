import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:5178/theme-ranking/', trace: 'retain-on-failure',
    launchOptions: process.env.CI ? {} : { channel: 'msedge' } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1100 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npm run dev -- --port 5178 --strictPort --base /theme-ranking/',
    url: 'http://127.0.0.1:5178/theme-ranking/',
    reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: 'https://browser-test.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'public-browser-test-fixture' },
  },
})
