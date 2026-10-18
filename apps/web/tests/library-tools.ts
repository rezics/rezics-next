import { expect, type Locator, type Page } from '@playwright/test';

/** Enter the secondary tools before opening an import or download section, including after a reload. */
export async function openLibraryTools(page: Page, label: string,
  activate: (summary: Locator) => Promise<void> = summary => summary.click()) {
  const summary = page.getByText(label, { exact: true });
  const details = summary.locator('xpath=parent::details');
  await expect(async () => {
    if (await details.getAttribute('open') !== null) return;
    await activate(summary);
    await expect(details).toHaveAttribute('open', '', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
