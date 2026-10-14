import { type Page } from '@playwright/test';

export const ACCOUNT = { email: 'tester@example.com', password: 'example-password', name: 'Test User' };

export const OWN_LOGIN = 'web/.auth/tester.json';

export async function signInThroughTheForm(page: Page, password = ACCOUNT.password): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill(ACCOUNT.email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export function places(page: Page) {
  return page.getByRole('list', { name: 'Places' }).getByRole('listitem');
}

export function place(page: Page, name: string) {
  return places(page).filter({ hasText: name });
}
