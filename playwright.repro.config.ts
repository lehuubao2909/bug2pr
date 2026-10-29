/**
 * Runs Bug2PR-generated repro specs (runs/replay/<bug>/repro.spec.ts)
 * against an already running target app.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'runs/replay',
  testMatch: '**/*.spec.ts',
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  // Short action timeout: a broken step should fail in seconds, not wait for the 60s test timeout
  // (matters when minimization tries many partial specs).
  use: { browserName: 'chromium', actionTimeout: 5_000, navigationTimeout: 15_000 },
});
