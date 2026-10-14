import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/visual-novels/collection-tracking-and-progress.json';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { BooksLibraryRecorded } from './books-library-recorded-page.tsx';

const collection = collectionRecord as AnswerRecord;

function sample(persona: AnswerPersona, label: string) {
  const found = collection.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${collection.row}/${persona}/${label}`);
  return found;
}

function actingSubject(path: string) {
  const subject = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded path has no actingSubject: ${path}`);
  return subject;
}

type ShelfDirectory = { statusShelves: { status: string; count: number }[] };

function counts(label: string) {
  const shelves = (sample('member', label).answer as ShelfDirectory).statusShelves;
  const count = (status: string) => shelves.find(item => item.status === status)?.count ?? 0;
  const reading = count('reading');
  const want = count('want-to-read');
  const read = count('read');
  return { reading, want, read, total: reading + want + read };
}

function librarySelections(checkpoint: 'empty' | 'reading' | 'read'): RecordedSelection[] {
  return [
    { label: `library-${checkpoint}-overview`, state: 'populated' },
    { label: 'library-visibility', state: 'populated' },
    { label: `library-${checkpoint}-rating-context`, state: 'populated' },
    // Goal, reading stats and followed authors were recorded with the empty shelves. The page reads those same paths.
    { label: 'library-empty-reading-goal', state: 'populated' },
    { label: 'library-empty-reading-stats', state: 'populated' },
    { label: 'library-empty-followed-authors', state: 'populated' },
    ...(checkpoint === 'reading' ? [
      { label: 'library-reading-reading-preview', state: 'populated' as const },
      { label: 'library-reading-resume', state: 'populated' as const },
    ] : []),
  ];
}

const year = Number(new URL(sample('member', 'library-empty-reading-goal').path, 'https://recorded.invalid')
  .searchParams.get('year'));
const member = actingSubject(sample('member', 'library-empty-overview').path);
const readingTitle = ((sample('member', 'library-reading-reading-preview').answer as {
  items: { card: { title: { value: string } } }[] }).items[0]?.card.title.value);
if (!readingTitle) throw new Error('Recorded reading shelf has no title');

const meta = {
  title: 'Library/Recorded visual novels', component: BooksLibraryRecorded,
  args: { record: collection, persona: 'member' as const, selections: librarySelections('reading'),
    actingSubject: member, year },
  parameters: { controls: { disable: true }, route: { pathname: '/en/library' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof BooksLibraryRecorded>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { globals: { viewport: { value: 'phone' as const } } };
const works = (total: number) => total === 1 ? '1 work' : `${total} works`;

async function expectShelfCounts(canvasElement: HTMLElement, label: string) {
  const canvas = within(canvasElement);
  const { reading, want, read, total } = counts(label);
  await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await expect(canvas.getByText(works(total))).toBeVisible();
  const shelves = within(canvas.getByRole('navigation', { name: 'Shelves' }));
  await expect(shelves.getByRole('link', { name: `All ${total}` })).toBeVisible();
  await expect(shelves.getByRole('link', { name: `Currently reading ${reading}` })).toBeVisible();
  await expect(shelves.getByRole('link', { name: `Want to read ${want}` })).toBeVisible();
  await expect(shelves.getByRole('link', { name: `Read ${read}` })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Who can see your reading shelves: Only you' })).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 2, name: `Reading in ${year}` })).toBeVisible();
  await expect(canvas.getByText('0 chapters completed')).toBeVisible();
}

/** Member’s recorded shelves before any visual novel is saved. */
export const MemberEmpty: Story = {
  args: { selections: librarySelections('empty') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
    await expect(canvas.getByText(works(counts('library-empty-overview').total))).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: 'Your library starts here' })).toBeVisible();
    await expect(canvas.getByText('Set a goal for books finished this year')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: `Reading in ${year}` })).toBeVisible();
    await expect(canvas.getByText('0 chapters completed')).toBeVisible();
    await expect(canvas.getByText('0 books finished')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Who can see your reading shelves: Only you' })).toBeVisible();
    await expect(canvas.queryByRole('navigation', { name: 'Shelves' })).toBeNull();
  },
};
export const MemberEmptyPhone: Story = { ...MemberEmpty, ...phone };

/** Member’s recorded visual novel on Currently reading, with no chapter to continue. */
export const MemberReading: Story = {
  play: async ({ canvasElement }) => {
    await expectShelfCounts(canvasElement, 'library-reading-overview');
    const canvas = within(canvasElement);
    const reading = within(canvas.getByRole('region', { name: 'Currently reading' }));
    await expect(reading.getByRole('heading', { level: 3, name: readingTitle })).toBeVisible();
    await expect(reading.getByRole('link', { name: new RegExp(`^Open\\b.*${readingTitle}`) })).toBeVisible();
    await expect(reading.queryByText(/Next:/)).toBeNull();
  },
};
export const MemberReadingPhone: Story = { ...MemberReading, ...phone };

/** Member’s recorded library after the visual novel is marked read. All does not list its title. */
export const MemberRead: Story = {
  args: { selections: librarySelections('read') },
  play: async ({ canvasElement }) => {
    await expectShelfCounts(canvasElement, 'library-read-overview');
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('region', { name: 'Currently reading' })).toBeNull();
    await expect(canvas.queryByRole('heading', { level: 3, name: readingTitle })).toBeNull();
  },
};
export const MemberReadPhone: Story = { ...MemberRead, ...phone };

/** The shelf read is held unanswered, so the page stays at its loading status. */
export const MemberLoading: Story = {
  args: { selections: [{ label: 'library-reading-overview', state: 'loading' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Loading…');
    await expect(canvas.queryByRole('heading', { name: 'Library' })).toBeNull();
  },
};
export const MemberLoadingPhone: Story = { ...MemberLoading, ...phone };
