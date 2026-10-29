/**
 * Records a screen-recording-style video of the seeded fixture bug:
 * add two todos, tick one as done, and the "items left" counter stays at 2.
 * Playwright records webm without a cursor, so we draw a fake cursor in the
 * page; ffmpeg then converts to H.264 mp4 (the format Meta video APIs accept).
 *
 * Usage: npm run fixture:record
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';

const APP = pathToFileURL(path.resolve('fixtures/buggy-todo-app/index.html')).href;
const OUT_DIR = path.resolve('fixtures/videos');
const OUT_MP4 = path.join(OUT_DIR, 'todo-counter-bug.mp4');
const VIEWPORT = { width: 1280, height: 800 };

// Arrow-shaped cursor that follows mouse events, so the video shows clicks.
const FAKE_CURSOR = `
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:99999;pointer-events:none;' +
      'border-left:12px solid transparent;border-right:12px solid transparent;border-bottom:28px solid #111;' +
      'transform-origin:top left;transform:rotate(-30deg);';
    document.body.appendChild(c);
    document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; });
  });
`;

/** Moves the mouse in small steps to an element's centre and clicks it. */
async function humanClick(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`No element for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await page.waitForTimeout(400);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(900);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: OUT_DIR, size: VIEWPORT } });
  await context.addInitScript(FAKE_CURSOR);
  const page = await context.newPage();
  await page.goto(APP);
  await page.mouse.move(200, 200);
  await page.waitForTimeout(1200);

  for (const text of ['Buy milk', 'Call the bank']) {
    await humanClick(page, '#new-todo');
    await page.keyboard.type(text, { delay: 90 });
    await humanClick(page, 'button[type=submit]');
  }
  await humanClick(page, 'li:first-child input[type=checkbox]'); // counter should drop to 1
  await page.mouse.move(640, 560, { steps: 20 }); // hover near the stale counter
  await page.waitForTimeout(2500);

  const webm = await page.video()!.path();
  await context.close();
  await browser.close();

  await rm(OUT_MP4, { force: true });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', OUT_MP4]);
  await rm(webm, { force: true });
  console.log(`Recorded ${path.relative(process.cwd(), OUT_MP4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
