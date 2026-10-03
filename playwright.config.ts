import { defineConfig, devices } from '@playwright/test'

const production = process.env.TEST_PRODUCTION === '1'
const baseURL = production ? 'http://localhost:4173' : 'http://localhost:5173'
const backgroundTest = process.env.BACKGROUND_TEST === '1'

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: 60_000,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chrome', use: {
    ...devices['Desktop Chrome'], channel: 'chrome', headless: !backgroundTest,
    // Playwright normally disables background throttling. The headed regression
    // intentionally uses normal browser policies and verifies a genuinely hidden tab.
    launchOptions: backgroundTest ? { ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] } : {},
  } }],
  webServer: { command: production ? 'npm run preview -- --host 127.0.0.1' : 'npm run dev -- --host 127.0.0.1', url: baseURL, reuseExistingServer: !process.env.CI },
})
