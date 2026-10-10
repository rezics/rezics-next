import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { signInAtAccounts } from './account-sign-in.ts';

// The owner removes a co-maintainer from the Maintainers panel while that
// person still has the recipe editor open.

const phone = { width: 390, height: 844 };
const typed = 'A note I still need.';

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

test.use({ actionTimeout: 20_000 });

test('a co-maintainer removed while editing keeps their text and is told why', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const seed = JSON.parse(readFileSync(resolve('.temp/revoked-maintainer', process.env.REZICS_QA_RUN_ID!, 'seed.json'), 'utf8')) as {
    work: string; owner: string; pen: string; generation: string; editorPath: string; panelPath: string;
  };
  const member = fixture<{ member: { email: string; password: string } }>('REZICS_WEB_AUTH_PRIVATE_PATH').member;
  const baseURL = info.project.use.baseURL as string;
  const editor = await browser.newContext({ baseURL, viewport: phone });
  const owner = await browser.newContext({ baseURL, viewport: phone });
  try {
    const cook = await editor.newPage();
    const remover = await owner.newPage();
    await signInAtAccounts(cook, '/en', member);
    await signInAtAccounts(remover, '/en', member);
    await cook.goto(seed.editorPath);
    await expect(cook.getByRole('heading', { name: 'About this recipe' })).toBeVisible();
    const notes = cook.getByRole('textbox', { name: 'Notes' });
    await notes.fill(typed);
    await remover.goto(seed.panelPath);
    const panel = remover.getByRole('region', { name: 'Maintainers' });
    await expect(panel.getByRole('button', { name: 'Remove Recipe co-maintainer' })).toBeVisible({ timeout: 30_000 });
    await panel.getByRole('button', { name: 'Remove Recipe co-maintainer' }).click();
    const dialog = remover.getByRole('alertdialog');
    await expect(dialog).toContainText('will no longer be able to edit this Work');
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Maintainer list updated');
    await expect(panel.getByRole('button', { name: 'Remove Recipe co-maintainer' })).toHaveCount(0);
    await notes.blur();
    await expect(cook.getByRole('alert')).toContainText('Your editing access was removed. What you typed is still here.');
    await expect(notes).toHaveValue(typed);
    await expect(notes).toBeEnabled();
    await expect(cook.getByRole('button', { name: 'Publish' })).toHaveCount(0);
    await expect(cook.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
    await expect(cook.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(cook.getByText('All changes saved')).toHaveCount(0);
    expect(await cook.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const shot = info.outputPath('revoked-maintainer.png');
    await cook.screenshot({ path: shot, fullPage: true });
    console.log(`[revoked-maintainer] screenshot ${shot}`);
  } finally {
    await editor.close();
    await owner.close();
  }
});
