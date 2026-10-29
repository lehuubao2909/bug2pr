import { expect, test } from '@playwright/test';

test('shadcn-filter-multiselect: two status options stay selected', async ({ page }) => {
  await page.goto('http://localhost:5173/tasks');
  await page.locator('button.border-dashed', { hasText: 'Status' }).click();
  await page.getByRole('option', { name: 'Todo' }).click();
  await page.getByRole('option', { name: 'In Progress' }).click();
  await page.keyboard.press('Escape');
  const statuses = await page.locator('tbody tr td:nth-child(4)').allInnerTexts();
  expect(statuses.some((s) => s.includes('Todo'))).toBe(true);
  expect(statuses.some((s) => s.includes('In Progress'))).toBe(true);
});
