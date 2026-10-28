import { expect } from 'bun:test';
import { chromium, type Page } from 'playwright';
import type { QueryClient } from '@tanstack/react-query';

/** Wait for a read started after session hydration, including an empty or failed result. */
export async function waitForPersonalRead(page: Page, queryKey: string[]) {
  await page.waitForFunction((key) => {
    const router = (
      window as Window & {
        __TSR_ROUTER__?: { options: { context: { queryClient: QueryClient } } };
      }
    ).__TSR_ROUTER__;
    const state = router?.options.context.queryClient.getQueryState(key);
    return state !== undefined && state.status !== 'pending' && state.fetchStatus === 'idle';
  }, queryKey);
}

/** Read the browser session query's token from the sign-out form, never from the public document head. */
export async function browserSessionToken(page: Page): Promise<string> {
  const field = page.locator('#account-menu input[name="csrf_token"]');
  await field.waitFor({ state: 'attached', timeout: 120_000 });
  const token = await field.inputValue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(await page.locator('meta[name="csrf-token"]').count()).toBe(0);
  return token;
}

export async function readSessionToken(origin: string, cookie: string): Promise<string> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const separator = cookie.indexOf('=');
    await context.addCookies([
      {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        domain: new URL(origin).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
    const page = await context.newPage();
    await page.goto(`${origin}/en/no-such-page`, { waitUntil: 'networkidle' });
    return await browserSessionToken(page);
  } finally {
    await browser.close();
  }
}
