/**
 * Converts "the agent clicked pixel (x, y)" into a stable, human-readable
 * Playwright locator (role + name, placeholder, test id, text), so the
 * generated spec does not depend on coordinates. Candidates are tried in order
 * of robustness; the first that resolves uniquely wins, otherwise we add
 * row scoping or an nth index.
 */
import type { ElementHandle, Page } from 'playwright';
import { toLocator, type LocatorSpec, type ScopedLocator } from './spec-actions.js';

type Described = {
  role?: string;
  name?: string;
  placeholder?: string;
  testId?: string;
  text?: string;
  rowText?: string; // distinctive text of the enclosing table row, for scoping
  rowTestId?: string;
};

// Runs in the browser: climb to the nearest interactive element and describe it.
function describeInBrowser(el: Element): Described {
  const target =
    el.closest('button,a[href],input,textarea,select,[role=button],[role=option],[role=menuitem],[role=checkbox],[role=tab],[role=link],[data-testid]') ?? el;
  const implicitRole = (e: Element): string | undefined => {
    const tag = e.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (e as HTMLInputElement).type;
      return t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : t === 'submit' || t === 'button' ? 'button' : 'textbox';
    }
    return undefined;
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const name = clean(target.getAttribute('aria-label')) || clean((target as HTMLElement).innerText).slice(0, 80) || clean(target.getAttribute('title'));
  const row = target.closest('tr,[data-testid=row],[role=row]');
  const rowText = row
    ? clean((row as HTMLElement).innerText)
        .split(/\s{1,}|\n/)
        .find((w) => /^[A-Za-z][A-Za-z-]{2,}$/.test(w)) // first word-like token: payee, task id prefix, ...
    : undefined;
  return {
    role: target.getAttribute('role') ?? implicitRole(target),
    name: name || undefined,
    placeholder: clean(target.getAttribute('placeholder')) || undefined,
    testId: target.getAttribute('data-testid') ?? undefined,
    text: clean((target as HTMLElement).innerText).slice(0, 80) || undefined,
    rowText,
    rowTestId: row?.getAttribute('data-testid') ?? undefined,
  };
}

function candidates(d: Described): ScopedLocator[] {
  const list: ScopedLocator[] = [];
  if (d.role && d.name) list.push({ by: 'role', role: d.role, name: d.name });
  if (d.placeholder) list.push({ by: 'placeholder', value: d.placeholder });
  if (d.testId && d.rowText) {
    const row: LocatorSpec = d.rowTestId ? { by: 'testId', value: d.rowTestId } : { by: 'css', value: 'tr' };
    list.push({ by: 'testId', value: d.testId, within: { locator: row, hasText: d.rowText } });
  }
  if (d.testId) list.push({ by: 'testId', value: d.testId });
  if (d.text) list.push({ by: 'text', value: d.text });
  return list;
}

/** Index of `handle` among the elements matched by `spec`, or -1. */
async function indexOf(page: Page, spec: ScopedLocator, handle: ElementHandle): Promise<number> {
  return toLocator(page, spec).evaluateAll((els, target) => els.findIndex((e) => e === target || e.contains(target as Node)), handle);
}

async function locatorFor(page: Page, handle: ElementHandle): Promise<ScopedLocator | undefined> {
  // tsx/esbuild wraps named inner functions in __name(); define it in the page
  // (as a string, so it is not transformed itself) before sending our function.
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  const described = await handle.evaluate(describeInBrowser);
  let fallback: ScopedLocator | undefined;
  for (const spec of candidates(described)) {
    const count = await toLocator(page, spec).count().catch(() => 0);
    if (count === 0) continue;
    const index = await indexOf(page, spec, handle).catch(() => -1);
    if (index < 0) continue;
    if (count === 1) return spec;
    fallback ??= { ...spec, nth: index };
  }
  return fallback;
}

export async function locatorAtPoint(page: Page, x: number, y: number): Promise<ScopedLocator | undefined> {
  const handle = (await page.evaluateHandle(([px, py]) => document.elementFromPoint(px!, py!), [x, y])).asElement();
  return handle ? locatorFor(page, handle as ElementHandle) : undefined;
}

export async function locatorOfFocused(page: Page): Promise<ScopedLocator | undefined> {
  const handle = (await page.evaluateHandle(() => document.activeElement)).asElement();
  return handle ? locatorFor(page, handle as ElementHandle) : undefined;
}
