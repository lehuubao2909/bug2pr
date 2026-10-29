/**
 * A tiny declarative action/locator language shared by three consumers:
 * running target setup, recording what the computer-use agent did, and
 * emitting the same steps as Playwright test code. One source of truth means
 * the generated spec replays exactly what the agent did in the browser.
 */
import type { Locator, Page } from 'playwright';

export type LocatorSpec =
  | { by: 'role'; role: string; name: string; exact?: boolean }
  | { by: 'testId'; value: string }
  | { by: 'placeholder'; value: string }
  | { by: 'text'; value: string; exact?: boolean }
  | { by: 'css'; value: string };

/** Optional scoping: inside the first element matching `within` that contains `hasText`, then nth match. */
export type ScopedLocator = LocatorSpec & {
  within?: { locator: LocatorSpec; hasText?: string };
  nth?: number;
};

export type SpecAction =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; locator: ScopedLocator }
  | { kind: 'type'; text: string }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; dx: number; dy: number }
  | { kind: 'wait'; ms: number }
  | { kind: 'waitFor'; locator: ScopedLocator };

const q = (s: string) => JSON.stringify(s);

function baseLocator(root: Page | Locator, spec: LocatorSpec): Locator {
  switch (spec.by) {
    case 'role':
      return root.getByRole(spec.role as never, { name: spec.name, exact: spec.exact ?? true });
    case 'testId':
      return root.getByTestId(spec.value);
    case 'placeholder':
      return root.getByPlaceholder(spec.value);
    case 'text':
      return root.getByText(spec.value, { exact: spec.exact ?? true });
    case 'css':
      return root.locator(spec.value);
  }
}

function baseCode(root: string, spec: LocatorSpec): string {
  switch (spec.by) {
    case 'role':
      return `${root}.getByRole(${q(spec.role)}, { name: ${q(spec.name)}, exact: ${spec.exact ?? true} })`;
    case 'testId':
      return `${root}.getByTestId(${q(spec.value)})`;
    case 'placeholder':
      return `${root}.getByPlaceholder(${q(spec.value)})`;
    case 'text':
      return `${root}.getByText(${q(spec.value)}, { exact: ${spec.exact ?? true} })`;
    case 'css':
      return `${root}.locator(${q(spec.value)})`;
  }
}

export function toLocator(page: Page, spec: ScopedLocator): Locator {
  let root: Page | Locator = page;
  if (spec.within) {
    let scope = baseLocator(page, spec.within.locator);
    if (spec.within.hasText) scope = scope.filter({ hasText: spec.within.hasText });
    root = scope.first();
  }
  const loc = baseLocator(root, spec);
  return spec.nth !== undefined ? loc.nth(spec.nth) : loc;
}

export function locatorCode(spec: ScopedLocator): string {
  let root = 'page';
  if (spec.within) {
    root = baseCode('page', spec.within.locator);
    if (spec.within.hasText) root += `.filter({ hasText: ${q(spec.within.hasText)} })`;
    root += '.first()';
  }
  const code = baseCode(root, spec);
  return spec.nth !== undefined ? `${code}.nth(${spec.nth})` : code;
}

export async function runAction(page: Page, action: SpecAction): Promise<void> {
  switch (action.kind) {
    case 'goto':
      return void (await page.goto(action.url));
    case 'click':
      return toLocator(page, action.locator).click();
    case 'type':
      return page.keyboard.type(action.text);
    case 'press':
      return page.keyboard.press(action.key);
    case 'scroll':
      return page.mouse.wheel(action.dx, action.dy);
    case 'wait':
      return page.waitForTimeout(action.ms);
    case 'waitFor':
      return toLocator(page, action.locator).first().waitFor();
  }
}

export function actionCode(action: SpecAction): string {
  switch (action.kind) {
    case 'goto':
      return `await page.goto(${q(action.url)});`;
    case 'click':
      return `await ${locatorCode(action.locator)}.click();`;
    case 'type':
      return `await page.keyboard.type(${q(action.text)});`;
    case 'press':
      return `await page.keyboard.press(${q(action.key)});`;
    case 'scroll':
      return `await page.mouse.wheel(${action.dx}, ${action.dy});`;
    case 'wait':
      return `await page.waitForTimeout(${action.ms});`;
    case 'waitFor':
      return `await ${locatorCode(action.locator)}.first().waitFor();`;
  }
}
