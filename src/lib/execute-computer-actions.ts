/**
 * Executes Meta computer-use actions (Responses API `computer_call.actions`)
 * against a Playwright page. Coordinates are pixels of the latest screenshot,
 * which equals the viewport because we screenshot at viewport size.
 */
import type { Page } from 'playwright';

export type ComputerAction =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'wheel' | 'back' | 'forward' }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'drag'; path: { x: number; y: number }[] }
  | { type: 'keypress'; keys: string[] }
  | { type: 'move'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; scroll_x: number; scroll_y: number }
  | { type: 'type'; text: string }
  | { type: 'screenshot' }
  | { type: 'wait' };

// Model key names -> Playwright key names (anything else is passed through).
const KEY_MAP: Record<string, string> = {
  CTRL: 'Control', CONTROL: 'Control', CMD: 'Meta', META: 'Meta', ALT: 'Alt', SHIFT: 'Shift',
  ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', ESCAPE: 'Escape', TAB: 'Tab', SPACE: 'Space',
  BACKSPACE: 'Backspace', DELETE: 'Delete', UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
};

const mouseButton = (b?: string): 'left' | 'right' | 'middle' =>
  b === 'right' ? 'right' : b === 'wheel' ? 'middle' : 'left';

export async function executeAction(page: Page, action: ComputerAction): Promise<void> {
  switch (action.type) {
    case 'click':
      if (action.button === 'back') return void (await page.goBack());
      if (action.button === 'forward') return void (await page.goForward());
      return page.mouse.click(action.x, action.y, { button: mouseButton(action.button) });
    case 'double_click':
      return page.mouse.dblclick(action.x, action.y);
    case 'drag': {
      const [first, ...rest] = action.path;
      if (!first) return;
      await page.mouse.move(first.x, first.y);
      await page.mouse.down();
      for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 5 });
      return page.mouse.up();
    }
    case 'keypress':
      return page.keyboard.press(action.keys.map((k) => KEY_MAP[k.toUpperCase()] ?? k).join('+'));
    case 'move':
      return page.mouse.move(action.x, action.y);
    case 'scroll':
      await page.mouse.move(action.x, action.y);
      return page.mouse.wheel(action.scroll_x, action.scroll_y);
    case 'type':
      return page.keyboard.type(action.text);
    case 'wait':
      return page.waitForTimeout(1000);
    case 'screenshot':
      return; // the loop captures a fresh screenshot after every batch anyway
    default:
      throw new Error(`Unsupported computer action: ${JSON.stringify(action)}`);
  }
}

/** Base64 PNG data URL of the current viewport, as computer_call_output expects. */
export async function screenshotDataUrl(page: Page): Promise<string> {
  const png = await page.screenshot({ type: 'png' });
  return `data:image/png;base64,${png.toString('base64')}`;
}
