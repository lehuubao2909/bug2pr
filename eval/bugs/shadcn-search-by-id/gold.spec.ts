import { expect, test } from '@playwright/test';

test('shadcn-search-by-id: searching a task ID shows that task', async ({ page }) => {
  await page.goto('http://localhost:5173/tasks');
  await page.getByPlaceholder('Filter by title or ID...').fill('TASK-7141');
  await expect(page.getByRole('cell', { name: 'TASK-7141' })).toBeVisible();
});
