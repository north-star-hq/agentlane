import { expect, test as setup } from '@playwright/test';

import { OWN_LOGIN, signInThroughTheForm } from './account';

setup('sign in as the test account', async ({ page }) => {
  await signInThroughTheForm(page);
  await expect(page.getByTestId('signed-in-as')).toBeVisible();
  await page.context().storageState({ path: OWN_LOGIN });
});
