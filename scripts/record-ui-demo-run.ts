/**
 * Records a real end-to-end run of the demo UI as a 1920x1080 video, plus a
 * timeline of stage transitions so the demo video can cut/speed up precisely.
 *
 * Usage: npx tsx scripts/record-ui-demo-run.ts <bug-id> <out-dir> [--private]
 * Needs `npm run ui` and the target app dev server running.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

async function main(): Promise<void> {
  const [bugId, outDir] = process.argv.slice(2);
  const privateMode = process.argv.includes('--private');
  if (!bugId || !outDir) throw new Error('usage: record-ui-demo-run.ts <bug-id> <out-dir> [--private]');
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const size = { width: 1920, height: 1080 };
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: outDir, size } });
  const page = await context.newPage();
  const t0 = Date.now();
  const timeline: { t: number; stage: string; status: string }[] = [];

  // Never start while another run is going: the page would open on its run view.
  while ((await (await fetch('http://localhost:4100/api/status')).json()).running) await new Promise((r) => setTimeout(r, 2000));
  await page.goto('http://localhost:4100', { waitUntil: 'load' });
  await page.click(`.bug-card[data-bug="${bugId}"]`);
  if (privateMode) await page.check('#private');
  await page.waitForTimeout(1500);
  timeline.push({ t: (Date.now() - t0) / 1000, stage: 'run', status: 'clicked' });
  await page.click('#run');
  // The page may hold a finished earlier run; wait for this run's `start` event to reset the view.
  await page.waitForFunction(() => document.body.dataset.view === 'run' && document.getElementById('banner')!.hidden);

  // Poll stage classes so we know when each stage started/finished in the recording.
  const seen = new Map<string, string>();
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      stages: [...document.querySelectorAll('.stage')].map((s) => [s.id, s.className] as const),
      banner: document.getElementById('banner')!.hidden ? '' : document.getElementById('banner')!.textContent,
    }));
    for (const [id, cls] of state.stages) {
      if (seen.get(id) !== cls) { seen.set(id, cls); timeline.push({ t: (Date.now() - t0) / 1000, stage: id, status: cls }); }
    }
    if (state.banner) { timeline.push({ t: (Date.now() - t0) / 1000, stage: 'banner', status: state.banner }); break; }
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(3000);
  const video = page.video();
  await context.close();
  await browser.close();
  await rename(await video!.path(), path.join(outDir, `${bugId}${privateMode ? '-private' : ''}.webm`));
  await writeFile(path.join(outDir, `${bugId}${privateMode ? '-private' : ''}.timeline.json`), JSON.stringify(timeline, null, 2));
  console.log(timeline.at(-1));
}

main().catch((err) => { console.error(err); process.exit(1); });
