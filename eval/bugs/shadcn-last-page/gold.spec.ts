import { expect, test } from '@playwright/test';

test('shadcn-last-page: last-page button goes to the last page', async ({ page }) => {
  await page.goto('http://localhost:5173/tasks');
  await page.getByRole('button', { name: 'Go to last page' }).click();
  // The label is rendered twice (one copy is hidden on narrow layouts): check the visible one.
  await expect(page.getByText('Page 10 of 10').filter({ visible: true })).toBeVisible();
});
