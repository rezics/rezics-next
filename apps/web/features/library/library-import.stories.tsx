import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { ImportApi } from './import-api.ts';
import { agentId, fakeImportApi, type FakeOptions, goodreadsRows, halfApplied } from './import-fixtures.ts';
import { type ImportShelf, memoryImportShelf, type PendingImport } from './import-store.ts';
import { LibraryImport } from './library-import.tsx';
import { messages } from './messages.ts';
import de from './messages/de.ts';
import ja from './messages/ja.ts';
import zhHans from './messages/zh-Hans.ts';

/** Each render gets its own Main and browser storage, so a story can be replayed. */
function Harness({ make, entries = [], ...props }: Omit<React.ComponentProps<typeof LibraryImport>, 'api' | 'shelf'>
  & { make: () => ImportApi; entries?: readonly PendingImport[] }) {
  const [api] = useState(make);
  const [shelf] = useState<ImportShelf>(() => memoryImportShelf(entries));
  return <LibraryImport {...props} api={api} shelf={shelf} />;
}
const pending = (over: Partial<PendingImport> = {}): PendingImport => ({ id: 'file-1', format: 'goodreads',
  name: 'goodreads_library_export.csv', total: 9, createdAt: Date.now(), intent: null, ...over });
const file = (name = 'goodreads_library_export.csv') => new File(['Title,Author\nPride and Prejudice,Jane Austen\n'], name, { type: 'text/csv' });
const faked = (options: FakeOptions = {}) => () => fakeImportApi(goodreadsRows(), options);

const meta = { title: 'Library/Import', component: Harness,
  args: { agent: agentId, context: agentId, locale: 'en', messages, make: faked() },
  parameters: { route: { pathname: '/en/library' } },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

async function openAndUpload(canvasElement: HTMLElement, name = 'goodreads_library_export.csv') {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.upload(canvas.getByLabelText('Library file'), file(name));
  await waitFor(() => expect(canvas.queryByText(/Checking matches:/)).toBeNull(), { timeout: 5000 });
  return canvas;
}

/** Matched, ambiguous and not-found rows, grouped by outcome; the reader chooses and keeps one private, then applies. */
export const Review: Story = { async play({ canvasElement }) {
  const canvas = await openAndUpload(canvasElement);
  await expect(canvas.getByRole('button', { name: /^Choose a match 2$/ })).toBeVisible();
  await expect(canvas.getByRole('button', { name: /^Not found 1$/ })).toBeVisible();
  await expect(canvas.getByRole('button', { name: /^Matched 6$/ })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Add to my library' })).toBeDisabled();
  await expect(canvas.getByText('Choose a match for 2 more rows, or keep them private, before adding.')).toBeVisible();
  const ambiguous = canvas.getAllByText('Ambiguous Tale')[0]!.closest('li')!;
  await userEvent.click(within(ambiguous).getAllByRole('button', { name: /Ambiguous Tale/ })[0]!);
  // The chosen row leaves this group for Matched.
  await waitFor(() => expect(canvas.getByRole('button', { name: /^Choose a match 1$/ })).toBeVisible());
  await userEvent.click(within(canvas.getAllByText('The Two Tales')[0]!.closest('li')!).getByRole('button', { name: /Keep private/ }));
  await waitFor(() => expect(canvas.getByRole('button', { name: 'Add to my library' })).toBeEnabled());
  await expect(canvas.getByRole('button', { name: /^Kept private 1$/ })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Add to my library' }));
  await expect(await canvas.findByText(/Finished: 9 of 9 rows/, undefined, { timeout: 5000 })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: /^All rows 9$/ }));
  await expect(canvas.getAllByText('Added to your library.').length).toBeGreaterThan(0);
} };

/** A not-found row offers Open Library candidates; adding one resolves the row to the new Work. */
export const NotFoundOpenLibrary: Story = { async play({ canvasElement }) {
  const canvas = await openAndUpload(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: /^Not found 1$/ }));
  await expect(canvas.getByText('From Open Library')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Add to REZICS' }));
  await waitFor(() => expect(canvas.getByRole('button', { name: /^Not found 0$/ })).toBeVisible());
  await expect(canvas.getByRole('button', { name: /^Matched 7$/ })).toBeVisible();
} };

/** The import was left half applied: it is listed on the page, and continuing finishes the rows that remain. */
export const PartialImport: Story = { args: { make: () => fakeImportApi(halfApplied()),
  entries: [pending({ intent: { context: agentId, language: 'und' } })] },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await expect(canvas.getByText('Unfinished imports')).toBeVisible();
  await expect(canvas.getByText('goodreads_library_export.csv · 9 rows')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: /Continue/ }));
  await expect(await canvas.findByText(/Finished: 9 of 9 rows/, undefined, { timeout: 5000 })).toBeVisible();
} };

/** The connection dropped while applying: nothing is lost, and Continue resumes where it stopped. */
export const InterruptedApply: Story = { args: { make: faked({ step: 2, failApplyAt: 2 }) },
  async play({ canvasElement }) {
    const canvas = await openAndUpload(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Keep every unmatched row private' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Add to my library' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Add to my library' }));
    await expect(await canvas.findByText(/Adding stopped before it finished/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
    await expect(await canvas.findByText(/Finished: 9 of 9 rows/, undefined, { timeout: 5000 })).toBeVisible();
  } };

/** Rows Main applied with a problem say so in words, and the reader sees what each row became. */
export const FinishedWithIssues: Story = { args: { make: () => fakeImportApi(halfApplied().map(row => ({ ...row,
  outcome: row.index === 2 ? { applied: [], issues: ['status-changed'] } : row.index === 7 ? { applied: ['private-source'], issues: ['unresolved-work'] }
    : { applied: ['status', 'private-source'], issues: [] } }))),
entries: [pending({ intent: { context: agentId, language: 'und' } })] },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByRole('button', { name: /Continue/ }));
  await expect(await canvas.findByText(/Finished: 7 of 9 rows/)).toBeVisible();
  await expect(canvas.getByText('Its reading shelf changed. Review it before retrying.')).toBeVisible();
  await expect(canvas.getByText('No Work was chosen, so it was kept private.')).toBeVisible();
} };

/** Any list with a title column: the reader maps columns and each status value; nothing is guessed. */
export const OtherCsv: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByLabelText('Other (CSV list)'));
  await expect(canvas.getByText('AniList lists cannot be imported.')).toBeVisible();
  await userEvent.upload(canvas.getByLabelText('Library file'), file('novelupdates.csv'));
  await expect(await canvas.findByRole('heading', { name: 'Map your columns' })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Check my books' })).toBeDisabled();
  await userEvent.click(canvas.getByRole('combobox', { name: 'Title (required)' }));
  await userEvent.click(await within(document.body).findByRole('option', { name: 'Title' }));
  await userEvent.click(canvas.getByRole('combobox', { name: 'Status' }));
  await userEvent.click(await within(document.body).findByRole('option', { name: 'Status' }));
  await expect(await canvas.findByText('“Dropped”')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Check my books' }));
  await expect(await canvas.findByRole('button', { name: /^Matched/ })).toBeVisible();
} };

export const Phone: Story = { globals: { viewport: { value: 'phone' } }, args: { make: () => fakeImportApi(halfApplied()),
  entries: [pending({ intent: { context: agentId, language: 'und' } })] },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByRole('button', { name: /Continue/ }));
  await expect(await canvas.findByText(/Finished: 9 of 9 rows/, undefined, { timeout: 5000 })).toBeVisible();
} };

export const PhoneReview: Story = { globals: { viewport: { value: 'phone' }, theme: 'dark' },
  async play({ canvasElement }) { await openAndUpload(canvasElement); } };

export const Chinese: Story = { args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '导入书架' })).toBeVisible();
    await userEvent.click(canvas.getByText('导入书架'));
    await expect(canvas.getByText('暂不支持导入 AniList 列表。')).toBeVisible();
  } };

export const German: Story = { args: { locale: 'de', messages: { ...messages, ...de } }, globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) { await userEvent.click(within(canvasElement).getByText('Bücher importieren')); } };

export const Japanese: Story = { args: { locale: 'ja', messages: { ...messages, ...ja } },
  async play({ canvasElement }) { await userEvent.click(within(canvasElement).getByText('本をインポート')); } };
