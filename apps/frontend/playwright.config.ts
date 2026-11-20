import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  workers: 1,
  timeout: 75_000,
  use: {
    baseURL: process.env.FRONTEND_ORIGIN ?? 'http://localhost:3001',
    channel: process.env.CHROME_CHANNEL,
    viewport: { width: 1280, height: 800 },
  },
});
