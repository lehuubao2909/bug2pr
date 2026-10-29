/**
 * Where each target app runs and the setup that puts it in the state the bug
 * video starts from (e.g. Actual needs a local budget and an open account).
 * Setup is declarative so it is both executed before replay and emitted at
 * the top of the generated spec.
 */
import type { SpecAction } from '../lib/spec-actions.js';

export type TargetApp = {
  name: string;
  url: string;
  viewport: { width: number; height: number };
  setup: SpecAction[];
};

export const targetApps: Record<string, TargetApp> = {
  'shadcn-admin': {
    name: 'shadcn-admin',
    url: process.env.SHADCN_ADMIN_URL ?? 'http://localhost:5173/tasks',
    viewport: { width: 1280, height: 900 },
    setup: [{ kind: 'waitFor', locator: { by: 'css', value: 'table' } }],
  },
  actual: {
    name: 'actual',
    url: process.env.ACTUAL_URL ?? 'http://localhost:3002/',
    viewport: { width: 1280, height: 900 },
    setup: [
      { kind: 'click', locator: { by: 'role', role: 'button', name: 'Create test file' } },
      { kind: 'click', locator: { by: 'role', role: 'link', name: 'Bank of America', exact: false, nth: 0 } },
      { kind: 'waitFor', locator: { by: 'testId', value: 'transaction-table' } },
    ],
  },
};

export function targetApp(name: string): TargetApp {
  const app = targetApps[name];
  if (!app) throw new Error(`Unknown target app: ${name}`);
  return app;
}
