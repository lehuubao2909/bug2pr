/**
 * Records the seeded todo fixture bug: add two todos, tick one as done, and
 * the "items left" counter stays at 2.
 *
 * Usage: npm run fixture:record
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { humanClick, humanType, recordScenario } from '../src/lib/record-scenario-video.js';

const APP = pathToFileURL(path.resolve('fixtures/buggy-todo-app/index.html')).href;
const OUT_MP4 = path.resolve('fixtures/videos/todo-counter-bug.mp4');

recordScenario(
  APP,
  OUT_MP4,
  async (page) => {
    for (const text of ['Buy milk', 'Call the bank']) {
      await humanClick(page, page.locator('#new-todo'));
      await humanType(page, text);
      await humanClick(page, page.locator('button[type=submit]'));
    }
    await humanClick(page, page.locator('li:first-child input[type=checkbox]')); // counter should drop to 1
    await page.mouse.move(640, 560, { steps: 20 }); // hover near the stale counter
  },
  { width: 1280, height: 800 },
)
  .then(() => console.log(`Recorded ${path.relative(process.cwd(), OUT_MP4)}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
