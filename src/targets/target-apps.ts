/**
 * Where each target app runs and how Bug2PR works with its repository:
 * - setup: puts the app in the state the bug video starts from (declarative,
 *   so it is both executed before replay and emitted at the top of the spec);
 * - repo/source dirs used to localize and fix the bug;
 * - regression commands that must stay green before a PR is allowed;
 * - where the generated regression test lives inside the target repo.
 */
import path from 'node:path';
import type { SpecAction } from '../lib/spec-actions.js';

export type Command = { cmd: string; args: string[]; cwd: string; env?: Record<string, string> };

export type TargetApp = {
  name: string;
  url: string;
  viewport: { width: number; height: number };
  setup: SpecAction[];
  repoDir: string;
  sourceDirs: string[]; // relative to repoDir; tests are never edited
  regression: Command[];
  testFile: (bugId: string) => string; // relative to repoDir
};

const TARGETS_ROOT = path.resolve(process.env.TARGETS_DIR ?? '../targets');

const shadcnDir = path.join(TARGETS_ROOT, 'shadcn-admin');
const actualDir = path.join(TARGETS_ROOT, 'actual');
const actualUrl = process.env.ACTUAL_URL ?? 'http://localhost:3002/';

export const targetApps: Record<string, TargetApp> = {
  'shadcn-admin': {
    name: 'shadcn-admin',
    url: process.env.SHADCN_ADMIN_URL ?? 'http://localhost:5173/tasks',
    viewport: { width: 1280, height: 900 },
    setup: [{ kind: 'waitFor', locator: { by: 'css', value: 'table' } }],
    repoDir: shadcnDir,
    sourceDirs: ['src'],
    regression: [
      { cmd: 'pnpm', args: ['exec', 'tsc', '-b'], cwd: shadcnDir },
      { cmd: 'pnpm', args: ['test'], cwd: shadcnDir },
    ],
    testFile: (id) => `e2e/bug2pr/${id}.spec.ts`,
  },
  actual: {
    name: 'actual',
    url: actualUrl,
    viewport: { width: 1280, height: 900 },
    setup: [
      { kind: 'click', locator: { by: 'role', role: 'button', name: 'Create test file' } },
      { kind: 'click', locator: { by: 'role', role: 'link', name: 'Bank of America', exact: false, nth: 0 } },
      { kind: 'waitFor', locator: { by: 'testId', value: 'transaction-table' } },
    ],
    repoDir: actualDir,
    sourceDirs: ['packages/desktop-client/src'],
    regression: [
      {
        cmd: 'npx',
        args: ['playwright', 'test', 'e2e/accounts.test.ts', '--retries=0', '--reporter=line', '--workers=4'],
        cwd: path.join(actualDir, 'packages/desktop-client'),
        env: { E2E_START_URL: actualUrl.replace(/\/$/, '') },
      },
    ],
    testFile: (id) => `packages/desktop-client/e2e/bug2pr-${id}.test.ts`,
  },
};

export function targetApp(name: string): TargetApp {
  const app = targetApps[name];
  if (!app) throw new Error(`Unknown target app: ${name}`);
  return app;
}
