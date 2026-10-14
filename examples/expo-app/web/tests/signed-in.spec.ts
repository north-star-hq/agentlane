import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { ACCOUNT, place, places } from './account';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('signed-in-as')).toHaveText(`Signed in as ${ACCOUNT.name} (${ACCOUNT.email})`);
});

test('a saved login opens on the places the API serves', async ({ page }) => {
  await expect(place(page, 'Harbor walk')).toContainText('25 min');
  await expect(place(page, 'Covered market')).toContainText('40 min');
  await expect(place(page, 'Small gallery')).toContainText('55 min');
  await expect(page.getByTestId('served-by')).toHaveText(/^Served by port \d+$/);
});

test('a place added on the signed-in page is stored and read back after a reload', async ({ page }) => {
  const name = `Test place ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Place', { exact: true }).fill(name);
  await page.getByLabel('Minutes', { exact: true }).fill('15');
  await page.getByRole('button', { name: 'Add place' }).click();
  await expect(place(page, name)).toContainText('15 min');

  await page.reload();
  await expect(page.getByTestId('signed-in-as')).toBeVisible();
  await expect(place(page, name)).toContainText('15 min');

  const response = await page.request.get('/api/items');
  expect(response.status()).toBe(200);
  const { items } = (await response.json()) as { items: { name: string; minutes: number }[] };
  expect(items).toContainEqual(expect.objectContaining({ name, minutes: 15 }));
});

test('shortest first orders the places by minutes, and pressing it again restores the order they were added in', async ({
  page,
}) => {
  const minutes = async () => (await places(page).allInnerTexts()).map(text => Number(/(\d+) min/.exec(text)?.[1] ?? Number.NaN));
  const quick = `Quick stop ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Place', { exact: true }).fill(quick);
  await page.getByLabel('Minutes', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Add place' }).click();
  await expect(place(page, quick)).toBeVisible();
  const added = await minutes();
  expect(added.at(-1)).toBe(1);
  const sort = page.getByRole('button', { name: 'Shortest first' });

  await sort.click();
  await expect(sort).toHaveAttribute('aria-pressed', 'true');
  expect(await minutes()).toEqual([...added].sort((a, b) => a - b));

  await sort.click();
  await expect(sort).toHaveAttribute('aria-pressed', 'false');
  expect(await minutes()).toEqual(added);
});
