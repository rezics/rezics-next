import type { Meta, StoryObj } from '@storybook/react-vite';
import { StrictMode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ImportError, mainImportApi, type ImportApi } from './import-api.ts';
import type { MainClient } from '../discover/types.ts';
import { agentId, fakeImportApi, type FakeOptions, goodreadsRows, halfApplied } from './import-fixtures.ts';
import { type ImportShelf, memoryImportShelf, type PendingImport } from './import-store.ts';
import { LibraryImport } from './library-import.tsx';
import { messages } from './messages.ts';
import de from './messages/de.ts';
import ja from './messages/ja.ts';
import zhHans from './messages/zh-Hans.ts';
import { chooseOption } from '../stories/choose-option.ts';

/** Each render gets its own Main and browser storage, so a story can be replayed. */
let remembered: ImportShelf | undefined;
function Harness({ make, entries = [], unmountControl = false, strictMode = false, ...props }: Omit<React.ComponentProps<typeof LibraryImport>, 'api' | 'shelf'>
  & { make: () => ImportApi; entries?: readonly PendingImport[]; unmountControl?: boolean; strictMode?: boolean }) {
  const [api] = useState(make);
  const [shelf] = useState<ImportShelf>(() => memoryImportShelf(entries));
  remembered = shelf;
  const [mounted, setMounted] = useState(true);
  const importer = mounted ? <LibraryImport {...props} api={api} shelf={shelf} /> : null;
  return <>{unmountControl ? <button type="button" onClick={() => setMounted(current => !current)}>
    {mounted ? 'Unmount importer' : 'Mount importer'}</button> : null}
  {strictMode ? <StrictMode>{importer}</StrictMode> : importer}</>;
}
const pending = (over: Partial<PendingImport> = {}): PendingImport => ({ id: 'file-1', format: 'goodreads',
  name: 'goodreads_library_export.csv', total: 9, createdAt: Date.now(), intent: null, ...over });
const file = (name = 'goodreads_library_export.csv') => new File(['Title,Author\nPride and Prejudice,Jane Austen\n'], name, { type: 'text/csv' });
let last: ReturnType<typeof fakeImportApi> | undefined;
const faked = (options: FakeOptions = {}): (() => ImportApi) => () => (last = fakeImportApi(goodreadsRows(), options));

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

/** The reader asks for the imported values to win over what the Library has: Main is told, row by row, to replace. */
export const UseImportedValues: Story = { async play({ canvasElement }) {
  const canvas = await openAndUpload(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Keep every unmatched row private' }));
  await expect(canvas.getByRole('radio', { name: 'Keep mine (default)' })).toBeChecked();
  await userEvent.click(canvas.getByRole('radio', { name: 'Use the imported value' }));
  await waitFor(() => expect(canvas.getByRole('button', { name: 'Add to my library' })).toBeEnabled());
  await userEvent.click(canvas.getByRole('button', { name: 'Add to my library' }));
  await expect(await canvas.findByText(/Finished: 9 of 9 rows/, undefined, { timeout: 5000 })).toBeVisible();
  await expect(last!.held.filter(row => row.resolution?.conflictChoice === 'replace')).toHaveLength(6);
} };

/** Another device changed the row first: it is reloaded from Main, so the second choice is made on its current version. */
export const ChangedElsewhere: Story = { args: { make: faked({ changedElsewhere: [6] }) }, async play({ canvasElement }) {
  const canvas = await openAndUpload(canvasElement);
  const row = () => canvas.getAllByText('Ambiguous Tale')[0]!.closest('li')!;
  await userEvent.click(within(row()).getAllByRole('button', { name: /Ambiguous Tale/ })[0]!);
  await expect(await within(row()).findByText(/changed elsewhere/)).toBeVisible();
  await userEvent.click(within(row()).getAllByRole('button', { name: /Ambiguous Tale/ })[0]!);
  await waitFor(() => expect(canvas.getByRole('button', { name: /^Choose a match 1$/ })).toBeVisible());
} };

/** A file over what one import takes is refused with its limit named, before anything is read. */
export const FileTooLarge: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.upload(canvas.getByLabelText('Library file'), new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.csv', { type: 'text/csv' }));
  await expect(await canvas.findByText(/larger than 2 MB/)).toBeVisible();
} };

/** A finished import can be deleted: the uploaded file and the private rows kept with it go. */
export const DeleteFinishedUpload: Story = { args: { make: () => fakeImportApi(halfApplied()),
  entries: [pending({ intent: { context: agentId, language: 'und' } })] },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByRole('button', { name: /Continue/ }));
  await expect(await canvas.findByText(/Finished: 9 of 9 rows/, undefined, { timeout: 5000 })).toBeVisible();
  await expect(canvas.getByText(/private rows kept with it/)).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Delete uploaded file' }));
  await expect(await canvas.findByText('Your current tool')).toBeVisible();
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
  await expect(canvas.getByText('Your Library already had a different reading status for this Work, so it was left unchanged.')).toBeVisible();
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
  await chooseOption(within(document.body), 'Title');
  await userEvent.click(canvas.getByRole('combobox', { name: 'Status' }));
  await chooseOption(within(document.body), 'Status');
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


/** Observation stops after admission exhaustion; an explicit check reads the durable job later. */
export const StillImporting: Story = { args: { make: () => {
  let reads=0;
  return { ...fakeImportApi(halfApplied()),status: async () => {
    if (reads++===0) return { total: 9,completed: 4,issues: 0,pending: true,state: 'pending' as const,reason: null };
    throw new ImportError('admission');
  } };
}, entries: [pending({ intent: { context: agentId, language: 'und' } })] },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByRole('button', { name: /Continue/ }));
  await expect(await canvas.findByText('Still importing. You can leave and come back.')).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Check progress' })).toBeEnabled();
  await expect(canvas.queryByText(/unavailable right now/)).toBeNull();
} };

/** A real server stall names its reason; only the explicit Continue command asks the server to resume. */
let explicitResume = false;
export const ServerStalled: Story = { args: { make: () => {
  explicitResume = false;
  const fake = fakeImportApi(halfApplied(), { step: 9 });
  return { ...fake, status: async () => ({
    total: 9, completed: 4, issues: 0, pending: false, state: 'stalled' as const, reason: 'lease-expired' as const,
  }), apply: async (id, intent, options) => { explicitResume = options?.resume === true; return fake.apply(id, intent, options); } };
}, entries: [pending({ intent: { context: agentId, language: 'und' } })] },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByRole('button', { name: /Continue/ }));
  await expect(await canvas.findByText(/worker did not finish in time/)).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await userEvent.click(canvas.getByRole('button', { name: 'Continue' }));
  await expect(await canvas.findByText(/Finished: 9 of 9 rows/)).toBeVisible();
  await expect(explicitResume).toBe(true);
} };

let admissionSignals: AbortSignal[] = [];
const permanentlyAdmitted = () => {
  admissionSignals = [];
  const main = { v1: { me: { 'library-imports': { post: async (_body: unknown,
    options: { fetch: { signal: AbortSignal } }) => {
    admissionSignals.push(options.fetch.signal);
    return { status: 429, data: null, response: new Response(null, {
      status: 429, headers: { 'retry-after': '1' },
    }) };
  } } } } } as unknown as MainClient;
  return mainImportApi(agentId, () => main);
};

/** Leaving while admission is waiting aborts the inner loop; remounting creates a usable fresh lifetime. */
export const CancelOnUnmount: Story = { args: { make: permanentlyAdmitted, unmountControl: true, strictMode: true },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.upload(canvas.getByLabelText('Library file'), file());
  await waitFor(() => expect(admissionSignals).toHaveLength(1));
  await userEvent.click(canvas.getByRole('button', { name: 'Unmount importer' }));
  await expect(admissionSignals[0]!.aborted).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await expect(admissionSignals).toHaveLength(1);
  await userEvent.click(canvas.getByRole('button', { name: 'Mount importer' }));
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.upload(canvas.getByLabelText('Library file'), file());
  await waitFor(() => expect(admissionSignals).toHaveLength(2));
  await expect(admissionSignals[1]!.aborted).toBe(false);
  await userEvent.click(canvas.getByRole('button', { name: 'Unmount importer' }));
} };

/** Closing an unfinished review keeps the choices. Continue must not remember an apply Main will refuse. */
export const ReviewStaysReview: Story = { async play({ canvasElement }) {
  const canvas = await openAndUpload(canvasElement);
  await expect(canvas.getByRole('button', { name: 'Add to my library' })).toBeDisabled();
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByText('Import your books'));
  await expect(canvas.getByRole('button', { name: 'Add to my library' })).toBeDisabled();
  await expect(canvas.getByText(/Choose a match for 2 more rows/)).toBeVisible();
  await expect(canvas.queryByRole('button', { name: /^Continue$/ })).toBeNull();
  await expect(remembered!.list(agentId).every(entry => entry.intent === null)).toBe(true);
  await expect(last!.calls).not.toContain('apply');
  const ambiguous = canvas.getAllByText('Ambiguous Tale')[0]!.closest('li')!;
  await userEvent.click(within(ambiguous).getAllByRole('button', { name: /Ambiguous Tale/ })[0]!);
  await waitFor(() => expect(canvas.getByRole('button', { name: /^Choose a match 1$/ })).toBeVisible());
  await expect(remembered!.list(agentId).every(entry => entry.intent === null)).toBe(true);
} };

/** Closing while a saved import is still loading resumes that read, instead of leaving an idle matcher. */
export const ResumeRowLoad: Story = { args: { make: () => {
  const fake = fakeImportApi(halfApplied(), { step: 9 });
  let reads = 0;
  return { ...fake, rows: async (id, cursor, options) => {
    if (++reads === 1) await new Promise<void>((_resolve, reject) => {
      const signal = options?.signal;
      const timer = setTimeout(() => reject(new Error('row load was not aborted')), 8_000);
      const abort = () => { clearTimeout(timer); reject(new DOMException('The operation was aborted.', 'AbortError')); };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
    });
    return fake.rows(id, cursor, options);
  } };
}, entries: [pending({ intent: { context: agentId, language: 'und' } })] },
async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByRole('button', { name: /Continue/ }));
  await expect(await canvas.findByText(/Checking matches:/)).toBeVisible();
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.click(canvas.getByText('Import your books'));
  await expect(await canvas.findByText(/Finished: 9 of 9 rows/, undefined, { timeout: 5000 })).toBeVisible();
} };

/** Closing the disclosure interrupts abandoned commands while the server keeps accepted jobs. */
export const CancelOnClose: Story = { args: { make: permanentlyAdmitted }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText('Import your books'));
  await userEvent.upload(canvas.getByLabelText('Library file'), file());
  await waitFor(() => expect(admissionSignals).toHaveLength(1));
  await userEvent.click(canvas.getByText('Import your books'));
  await waitFor(() => expect(admissionSignals[0]!.aborted).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 1100));
  await expect(admissionSignals).toHaveLength(1);
} };
