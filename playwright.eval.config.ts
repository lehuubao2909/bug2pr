/**
 * Runs the hand-written gold specs in eval/bugs/<id>/gold.spec.ts against a
 * running target app. A gold spec must FAIL on the bug branch and PASS on the
 * fixed code; it is the reference the agent-generated test is compared to.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'eval/bugs',
  testMatch: '**/gold.spec.ts',
  retries: 0,
  reporter: 'line',
  use: { viewport: { width: 1280, height: 900 } },
});
