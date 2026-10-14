import { expect, test } from '@playwright/test';

import { ACCOUNT, place, signInThroughTheForm } from './account';

test('a wrong password is refused and the sign-in page stays', async ({ page }) => {
  await signInThroughTheForm(page, 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText('wrong email or password');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('signing in through the form shows the signed-in page', async ({ page }) => {
  await signInThroughTheForm(page);
  await expect(page.getByTestId('signed-in-as')).toHaveText(`Signed in as ${ACCOUNT.name} (${ACCOUNT.email})`);
  await expect(place(page, 'Harbor walk')).toBeVisible();
});

test('signing out returns to the sign-in page, and the API then refuses writes', async ({ page }) => {
  await signInThroughTheForm(page);
  await expect(page.getByTestId('signed-in-as')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const response = await page.request.post('/api/items', { data: { name: 'Not stored', minutes: 5 } });
  expect(response.status()).toBe(401);
});
