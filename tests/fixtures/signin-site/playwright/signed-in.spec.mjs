import { expect, test } from '@playwright/test';

test("the lane's saved login opens this lane's signed-in page", async ({ page }) => {
  await page.goto('/');
  expect(page.url()).toBe(process.env.AGENTLANE_WEB_URL);
  await expect(page.getByRole('heading', { name: `Signed in as agent-${process.env.AGENTLANE_LANE}` })).toBeVisible();
});

test('a failing step keeps its trace', async ({ page }) => {
  test.skip(process.env.FIXTURE_FAIL !== '1', 'set FIXTURE_FAIL=1 to make it fail');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Not on this page' })).toBeVisible({ timeout: 1000 });
});
