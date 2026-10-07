import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import * as fixture from './fixtures.ts';
import { createMemoryMain, memoryTracking } from './memory.ts';
import { copyOf } from './messages.ts';
import { TrackingSheet } from './tracking-sheet.tsx';
import type { TrackingApi } from './api.ts';
import type { Release } from './types.ts';

function manyReleases(count: number): Release[] {
  const template = fixture.editions.releases[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    id: fixture.iri(`e${index + 1}`),
    title: { ...template.title, value: `Release ${index + 1}` },
  }));
}

/** Pages of 20 releases. `failOnce` refuses the first continuation, then answers it. */
function pagingApi(count: number, failOnce: boolean): TrackingApi {
  const listed = manyReleases(count);
  const base = memoryTracking(createMemoryMain());
  let failures = failOnce ? 1 : 0;
  return {
    ...base,
    async editions(_work, page) {
      if (page?.releases && failures > 0) {
        failures -= 1;
        return { ok: false, failure: 'unavailable' };
      }
      const start = page?.releases ? Number(page.releases) : 0;
      const items = listed.slice(start, start + 20);
      const next = start + 20 < listed.length ? String(start + 20) : null;
      return { ok: true, data: { realizations: [], releases: items, realizationsCursor: null, releasesCursor: next,
        more: next !== null } };
    },
  };
}

function OpenSheet({ count, failOnce }: { count: number; failOnce: boolean }) {
  const [api] = useState(() => pagingApi(count, failOnce));
  const [open, setOpen] = useState(true);
  return <TrackingSheet work={fixture.saoOne} title={fixture.saoOneTitle} api={api} locale="en" open={open}
    onOpenChange={setOpen} />;
}

const t = copyOf('en');
const releaseName = (number: number) => `Release ${number} · paperback`;

async function openDialog() {
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog).toBeVisible());
  await within(dialog).findByRole('region', { name: 'Start an attempt' });
  return dialog;
}

/** Option labels from the edition select, ignoring the native select Storybook keeps beside the popup. */
async function editionLabels(dialog: HTMLElement): Promise<string[]> {
  const start = within(dialog).getByRole('region', { name: 'Start an attempt' });
  await userEvent.click(within(start).getByRole('combobox', { name: 'Edition' }));
  try {
    const options = await within(document.body).findAllByRole('option');
    return options.filter(option => !option.closest('select')).map(option => option.textContent ?? '')
      .filter(label => label.startsWith('Release '));
  } finally {
    await userEvent.keyboard('{Escape}');
  }
}

const fits = async (dialog: HTMLElement) => {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
};

const listed = (dialog: HTMLElement) => dialog.querySelector('[data-listed-editions]')?.getAttribute('data-listed-editions');

const meta = {
  title: 'Tracking/Edition pages',
  component: OpenSheet,
  args: { count: 45, failOnce: false },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OpenSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Forty-five releases, a page at a time, on a 390 px phone: later pages keep their order and can be filtered. */
export const FortyFiveEditions: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    const dialog = await openDialog();
    const sheet = within(dialog);
    await expect(sheet.getByRole('button', { name: t.moreEditions })).toBeVisible();
    await fits(dialog);
    await expect(listed(dialog)).toBe('20');
    await expect(await editionLabels(dialog)).toEqual(Array.from({ length: 20 }, (_, index) => releaseName(index + 1)));

    await userEvent.click(sheet.getByRole('button', { name: t.moreEditions }));
    await waitFor(() => expect(listed(dialog)).toBe('40'));
    const second = await editionLabels(dialog);
    await expect(second).toContain(releaseName(21));
    await expect(second.indexOf(releaseName(1))).toBeLessThan(second.indexOf(releaseName(21)));
    await expect(second.filter(label => label === releaseName(1))).toHaveLength(1);
    await expect(second.filter(label => label === releaseName(20))).toHaveLength(1);

    await userEvent.click(sheet.getByRole('button', { name: t.moreEditions }));
    await waitFor(() => expect(listed(dialog)).toBe('45'));
    await expect(sheet.queryByRole('button', { name: t.moreEditions })).toBeNull();
    const all = await editionLabels(dialog);
    await expect(all).toHaveLength(45);
    await expect(all[44]).toBe(releaseName(45));
    await expect(new Set(all).size).toBe(45);

    await userEvent.type(sheet.getByRole('textbox', { name: t.filterEditions }), 'Release 45');
    await expect(await editionLabels(dialog)).toEqual([releaseName(45)]);
    await fits(dialog);
  },
};

/** A full page that is also the last page has nothing further to open. */
export const ExactlyTwenty: Story = {
  args: { count: 20 },
  globals: { viewport: { value: 'phone' } },
  async play() {
    const dialog = await openDialog();
    await expect(within(dialog).queryByRole('button', { name: t.moreEditions })).toBeNull();
    await expect(await editionLabels(dialog)).toEqual(Array.from({ length: 20 }, (_, index) => releaseName(index + 1)));
    await fits(dialog);
  },
};

/** The next page fails, the first page stays, and trying again reads that same page. */
export const NextPageFailed: Story = {
  args: { count: 25, failOnce: true },
  globals: { viewport: { value: 'phone' } },
  async play() {
    const dialog = await openDialog();
    const sheet = within(dialog);
    await userEvent.click(sheet.getByRole('button', { name: t.moreEditions }));
    const alert = await sheet.findByRole('alert');
    await expect(alert).toHaveTextContent(t.moreEditionsFailed);
    await expect(sheet.getByRole('button', { name: t.retry })).toBeVisible();
    await expect(await editionLabels(dialog)).toEqual(Array.from({ length: 20 }, (_, index) => releaseName(index + 1)));
    await userEvent.click(sheet.getByRole('button', { name: t.retry }));
    await waitFor(() => expect(listed(dialog)).toBe('25'));
    const recovered = await editionLabels(dialog);
    await expect(recovered).toHaveLength(25);
    await expect(recovered).toContain(releaseName(21));
    await fits(dialog);
  },
};
