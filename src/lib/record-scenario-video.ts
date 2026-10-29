/**
 * Records a screen-recording-style mp4 of a scripted UI scenario.
 * Playwright's video has no cursor, so a visible fake cursor is injected and
 * clicks move the mouse smoothly; ffmpeg converts webm -> H.264 mp4, the
 * format the Meta video and SAM APIs accept.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';

export type Viewport = { width: number; height: number };

// Arrow-shaped cursor that follows mouse events, so clicks are visible in video.
const FAKE_CURSOR = `
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;' +
      'border-left:12px solid transparent;border-right:12px solid transparent;border-bottom:28px solid #111;' +
      'transform-origin:top left;transform:rotate(-30deg);';
    document.body.appendChild(c);
    document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; });
  });
`;

/** Moves the mouse in small steps to the element's centre, then clicks it. */
export async function humanClick(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`Element not visible: ${target.toString()}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
  await page.waitForTimeout(400);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(900);
}

/** Types like a person, with a short pause afterwards so the result is visible. */
export async function humanType(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 90 });
  await page.waitForTimeout(800);
}

/**
 * Opens url, runs scenario with a recording context, and writes outMp4.
 * A scenario may call markStart() after app setup (e.g. creating test data);
 * everything before that moment is trimmed from the final video.
 * The final pause keeps the buggy end state on screen for the viewer.
 */
export async function recordScenario(
  url: string,
  outMp4: string,
  scenario: (page: Page, markStart: () => void) => Promise<void>,
  viewport: Viewport = { width: 1280, height: 900 },
): Promise<void> {
  const dir = path.dirname(outMp4);
  await mkdir(dir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport, recordVideo: { dir, size: viewport } });
  await context.addInitScript(FAKE_CURSOR);
  const page = await context.newPage();
  const recordingStartedAt = Date.now(); // video recording starts with the page
  let trimSeconds = 0;
  const markStart = () => {
    trimSeconds = (Date.now() - recordingStartedAt) / 1000;
  };
  let failure: unknown;
  try {
    // 'load' not 'networkidle': dev servers keep HMR sockets and workers busy.
    await page.goto(url, { waitUntil: 'load' });
    await page.mouse.move(viewport.width / 2, viewport.height / 3);
    await page.waitForTimeout(1200);
    await scenario(page, markStart);
    await page.waitForTimeout(2500);
  } catch (err) {
    failure = err;
  } finally {
    await context.close();
    await browser.close();
  }

  const webm = await page.video()!.path();
  if (failure) {
    await rm(webm, { force: true }); // don't leave half-recorded webm files behind
    throw failure;
  }
  await rm(outMp4, { force: true });
  const trim = trimSeconds > 0 ? ['-ss', trimSeconds.toFixed(2)] : [];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, ...trim, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', outMp4]);
  await rm(webm, { force: true });
}
