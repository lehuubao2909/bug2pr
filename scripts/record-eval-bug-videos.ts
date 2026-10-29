/**
 * Records one screen-recording video per eval bug.
 * For each bug it checks out the bug branch in the target repo (the running
 * Vite dev server hot-reloads), plays the scenario and writes
 * eval/bugs/<id>/video.mp4. Ground truth lives next to it in truth.json.
 *
 * Usage: npm run eval:record [-- <bug-id> ...]
 * Needs: shadcn-admin dev server on :5173, Actual dev server on :3002.
 * Env:   SHADCN_ADMIN_DIR, ACTUAL_DIR (default ../targets/<app>)
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { humanClick, humanType, recordScenario } from '../src/lib/record-scenario-video.js';

const TARGET_DIRS: Record<string, string> = {
  'shadcn-admin': path.resolve(process.env.SHADCN_ADMIN_DIR ?? '../targets/shadcn-admin'),
  actual: path.resolve(process.env.ACTUAL_DIR ?? '../targets/actual'),
};
const DEFAULT_BRANCH: Record<string, string> = { 'shadcn-admin': 'main', actual: 'bug/8475-running-balance' };

type Scenario = (page: Page, markStart: () => void) => Promise<void>;

// Each scenario mirrors the "steps" in the bug's truth.json.
const scenarios: Record<string, Scenario> = {
  'shadcn-search-by-id': async (page) => {
    await humanClick(page, page.getByPlaceholder('Filter by title or ID...'));
    await humanType(page, 'TASK-7141');
    await page.mouse.move(640, 420, { steps: 20 }); // hover over the empty table
  },
  'shadcn-filter-multiselect': async (page) => {
    // Toolbar filter button (dashed border), not the sortable "Status" column header.
    await humanClick(page, page.locator('button.border-dashed', { hasText: 'Status' }));
    await humanClick(page, page.getByRole('option', { name: 'Todo' }));
    await humanClick(page, page.getByRole('option', { name: 'In Progress' }));
  },
  'shadcn-last-page': async (page) => {
    await humanClick(page, page.getByRole('button', { name: 'Go to last page' }));
    await page.mouse.move(800, 860, { steps: 20 }); // hover near "Page x of y"
  },
  'actual-8475-running-balance': async (page, markStart) => {
    // Setup (trimmed from the video): local test budget, open an account.
    await page.getByRole('button', { name: 'Create test file', exact: true }).click();
    await page.getByRole('link', { name: /^Bank of America/ }).first().click();
    await page.getByTestId('transaction-table').waitFor();
    await page.getByRole('button', { name: 'Close' }).click({ timeout: 3000 }).catch(() => {}); // update toast
    await page.mouse.move(700, 450);
    await page.waitForTimeout(1000);
    markStart();

    await humanClick(page, page.getByRole('button', { name: 'Account menu' }));
    await humanClick(page, page.getByRole('button', { name: 'Show running balance' }));
    const row = page.getByTestId('transaction-table').getByTestId('row').filter({ hasText: 'Movies' }).first();
    await humanClick(page, row.getByTestId('debit'));
    await page.keyboard.press('ControlOrMeta+a');
    await humanType(page, '50.00');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(800);
    await page.mouse.move(1180, 300, { steps: 20 }); // hover over the stale Balance column
  },
};

async function recordBug(id: string): Promise<void> {
  const scenario = scenarios[id];
  if (!scenario) throw new Error(`No scenario for ${id}`);
  const dir = path.resolve('eval/bugs', id);
  const truth = JSON.parse(await readFile(path.join(dir, 'truth.json'), 'utf8')) as { app: string; branch: string; url: string };
  const target = TARGET_DIRS[truth.app];
  if (!target) throw new Error(`Unknown app ${truth.app}`);

  execFileSync('git', ['-C', target, 'checkout', '-q', truth.branch]);
  await new Promise((r) => setTimeout(r, 2500)); // let Vite pick up the branch switch
  try {
    await recordScenario(truth.url, path.join(dir, 'video.mp4'), scenario);
  } finally {
    execFileSync('git', ['-C', target, 'checkout', '-q', DEFAULT_BRANCH[truth.app]!]);
  }
  console.log(`Recorded ${id} (${truth.branch})`);
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
  for (const id of ids) await recordBug(id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
