import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/books/collection-tracking-and-progress.json';
import importRecord from '../../../../tests/qa/fixtures/outcomes/books/library-import.json';
import resumeRecord from '../../../../tests/qa/fixtures/outcomes/books/resume-an-interrupted-export-interrupted-exports.json';
import { memoryExportStore } from '../library-backup/export-store.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { AppShell } from '../shell/app-shell.tsx';
import { messages as shell } from '../shell/messages.ts';
import { BooksLibraryRecorded, RecordedLibraryImport } from './books-library-recorded-page.tsx';
import { memoryImportShelf } from './import-store.ts';
import { messages } from './messages.ts';

const collection = collectionRecord as AnswerRecord;
const imported = importRecord as AnswerRecord;
const resume = resumeRecord as AnswerRecord;

function sample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${record.row}/${persona}/${label}`);
  return found;
}

function actingSubject(path: string) {
  const subject = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded path has no actingSubject: ${path}`);
  return subject;
}

const ownerShelves = sample(collection, 'owner', 'shelf-directory');
const ownerAgent = actingSubject(ownerShelves.path);
const ownerLibrary: RecordedSelection[] = [
  { label: 'shelf-directory', state: 'populated' },
  { label: 'library-visibility', state: 'populated' },
  { label: 'global-rating-context', state: 'populated' },
  { label: 'yearly-reading-goal', state: 'populated' },
  { label: 'chapter-reading-stats', state: 'populated' },
  { label: 'followed-authors', state: 'populated' },
  { label: 'currently-reading-preview', state: 'populated' },
  { label: 'book-reading-resume', state: 'populated' },
  { label: 'series-reading-resume', state: 'populated' },
  { label: 'book-card-and-chapter-count', state: 'populated' },
];

const resumeShelves = sample(resume, 'owner', 'shelf-overview');
const exportAgent = actingSubject(resumeShelves.path);
const changedExport = sample(resume, 'owner', 'get-library-export-6');
const exportLibrary: RecordedSelection[] = [
  { label: 'shelf-overview', state: 'populated' },
  { label: 'library-visibility', state: 'populated' },
  { label: 'rating-context', state: 'populated' },
  { label: 'reading-goal', state: 'populated' },
  { label: 'reading-stats', state: 'populated' },
  { label: 'followed-authors', state: 'populated' },
  { label: changedExport.label, state: 'error' },
];

const visitorRows = sample(imported, 'visitor', 'get-library-imports-rows-0');
const visitorImport = {
  actingSubject: actingSubject(visitorRows.path),
  selections: [{ label: visitorRows.label, state: 'error' }] as RecordedSelection[],
  shelf: memoryImportShelf([{ id: visitorRows.path.split('/')[4]!, format: 'rezics', name: visitorRows.path.split('/')[4]!,
    total: 1, createdAt: Date.now(), intent: null }]),
};

function ChangedExport(args: { year: number }) {
  const [store] = useState(() => memoryExportStore());
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    const url = new URL(changedExport.path, 'https://recorded.invalid');
    void store.append(exportAgent, { snapshot: url.searchParams.get('snapshot') ?? '',
      cursor: url.searchParams.get('cursor'), pages: 1, rows: 0, done: false }, []).then(() => setSeeded(true));
  }, [store]);
  if (!seeded) return <p role="status">Loading…</p>;
  return <BooksLibraryRecorded record={resume} persona="owner" selections={exportLibrary} actingSubject={exportAgent}
    year={args.year} exportStore={store} />;
}

const meta = {
  title: 'Library/Recorded books', component: BooksLibraryRecorded,
  args: { record: collection, persona: 'owner' as const, selections: ownerLibrary, actingSubject: ownerAgent, year: 2026 },
  parameters: { controls: { disable: true }, route: { pathname: '/en/library' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof BooksLibraryRecorded>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { globals: { viewport: { value: 'phone' as const } } };

async function expectOwnerLibrary(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  const shelves = within(canvas.getByRole('navigation', { name: 'Shelves' }));
  await expect(shelves.getByRole('link', { name: 'All 2' })).toBeVisible();
  await expect(shelves.getByRole('link', { name: 'Currently reading 2' })).toBeVisible();
  await expect(shelves.getByRole('link', { name: 'Want to read 0' })).toBeVisible();
  await expect(shelves.getByRole('link', { name: 'Read 0' })).toBeVisible();
  const reading = within(canvas.getByRole('region', { name: 'Currently reading' }));
  await expect(reading.getByRole('heading', { level: 3, name: 'Original outcome series' })).toBeVisible();
  await expect(reading.getByRole('heading', { level: 3, name: 'Original outcome volume' })).toBeVisible();
  await expect(reading.getByRole('link', { name: /^Continue/ })).toBeVisible();
  await expect(reading.getByText(/Next: Chapter 1/)).toBeVisible();
  await expect(reading.getByText(/2 chapters left/)).toBeVisible();
  const tools = canvas.getByText(messages.libraryTools, { selector: 'summary' });
  await expect(tools.closest('details')).not.toHaveAttribute('open');
  await userEvent.click(tools);
  await expect(canvas.getByRole('heading', { level: 2, name: 'Reading in 2026' })).toBeVisible();
  await expect(canvas.getByText('1 chapter completed')).toBeVisible();
  await userEvent.click(tools);
  window.scrollTo(0, 0);
}

/** Owner’s recorded shelves, reading status and the next chapter. */
export const OwnerPopulated: Story = { play: async ({ canvasElement }) => { await expectOwnerLibrary(canvasElement); } };
export const OwnerPopulatedPhone: Story = { ...OwnerPopulated, ...phone };

/** The recorded successful API state inside the app's actual navigation chrome. */
export const OwnerReadingFirst: Story = {
  render: args => <AppShell locale="en" messages={shell} theme="light" navCollapsed={false} signedIn
    account={<span className="text-sm">Reader</span>}><BooksLibraryRecorded {...args} /></AppShell>,
  globals: { viewport: { value: 'desktop1440' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const reading = await canvas.findByRole('region', { name: 'Currently reading' });
    const title = within(reading).getByRole('heading', { name: 'Original outcome series' });
    const open = within(reading).getByRole('link', { name: /^Open/ });
    await document.fonts.ready;
    window.scrollTo(0, 0);
    const header = canvasElement.querySelector('header')!.getBoundingClientRect();
    const fixedNav = [...canvasElement.querySelectorAll('nav')]
      .find(nav => getComputedStyle(nav).position === 'fixed' && nav.checkVisibility()
        && nav.getBoundingClientRect().height > 0);
    const bottom = fixedNav?.getBoundingClientRect().top ?? window.innerHeight;
    for (const item of [title, open]) {
      const box = item.getBoundingClientRect();
      await expect(box.top).toBeGreaterThanOrEqual(header.bottom);
      await expect(box.bottom).toBeLessThanOrEqual(bottom);
      await expect(box.left).toBeGreaterThanOrEqual(0);
      await expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    }
    await expect(canvas.getByRole('heading', { name: 'Reading in 2026', hidden: true })).not.toBeVisible();
    const tools = canvas.getByText(messages.libraryTools, { selector: 'summary' });
    await expect(tools.closest('details')).not.toHaveAttribute('open');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const continuation = within(reading).getByRole('link', { name: /^Continue/ });
    continuation.focus();
    await waitFor(() => {
      const box = continuation.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
      expect(window.scrollX).toBe(0);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    });
    await userEvent.click(tools);
    await expect(canvas.getByRole('heading', { name: 'Reading in 2026' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    await userEvent.click(tools);
    await expect(tools.closest('details')).not.toHaveAttribute('open');
    reading.querySelector('ul')!.scrollLeft = 0;
    window.scrollTo(0, 0);
  },
};
export const OwnerReadingFirstPhone: Story = { ...OwnerReadingFirst, ...phone };

/** The shelf read is held unanswered, so the page stays at its loading status. */
export const OwnerLoading: Story = {
  args: { selections: [{ label: 'shelf-directory', state: 'loading' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Loading…');
    await expect(canvas.queryByRole('heading', { name: 'Library' })).toBeNull();
  },
};
export const OwnerLoadingPhone: Story = { ...OwnerLoading, ...phone };

async function expectChangedExport(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  const shelves = within(canvas.getByRole('navigation', { name: 'Shelves' }));
  await expect(shelves.getByRole('link', { name: 'Want to read 1' })).toBeVisible();
  await expect(shelves.getByRole('link', { name: /Empty private shelf/ })).toBeVisible();
  await expect(shelves.getByRole('link', { name: /Private portable shelf/ })).toBeVisible();
  await userEvent.click(canvas.getByText(messages.libraryTools, { selector: 'summary' }));
  await userEvent.click(canvas.getByRole('heading', { level: 2, name: 'Download your library' }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Resume download' }));
  await expect(await canvas.findByRole('alert')).toHaveTextContent(
    'Your library changed or this download expired, so it cannot continue. Start over to get a consistent file.');
  await expect(canvas.getByRole('button', { name: 'Start over' })).toBeVisible();
}

/** Owner resumes an export whose recorded basis changed, and the page offers a restart. */
export const OwnerExportChanged: Story = {
  args: { record: resume, selections: exportLibrary, actingSubject: exportAgent },
  render: args => <ChangedExport year={args.year} />,
  play: async ({ canvasElement }) => { await expectChangedExport(canvasElement); },
};
export const OwnerExportChangedPhone: Story = { ...OwnerExportChanged, ...phone };

async function expectVisitorImportRefused(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('heading', { level: 2, name: 'Import your books' }));
  await userEvent.click(await canvas.findByRole('button', { name: /^Continue/ }));
  await expect(await canvas.findByRole('alert')).toHaveTextContent(
    'You do not have permission to import this library.');
}

/** A signed-out reader’s import rows stay refused. */
export const VisitorImportRefused: Story = {
  render: () => <RecordedLibraryImport record={imported} persona="visitor" selections={visitorImport.selections}
    actingSubject={visitorImport.actingSubject} shelf={visitorImport.shelf} />,
  play: async ({ canvasElement }) => { await expectVisitorImportRefused(canvasElement); },
};
export const VisitorImportRefusedPhone: Story = { ...VisitorImportRefused, ...phone };
