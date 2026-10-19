import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/visual-novels/collection-tracking-and-progress.json';
import { localizedPath } from '../../i18n/locale.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { workHref } from '../work-page/route.ts';
import { BooksLibraryRecorded } from './books-library-recorded-page.tsx';
import { messages } from './messages.ts';
import { parseLibraryState } from './state.ts';

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

function populated(labels: readonly string[]): RecordedSelection[] {
  return labels.map(label => ({ label, state: 'populated' }));
}

const emptyLibrary = populated([
  'library-empty-overview', 'library-visibility', 'library-empty-rating-context', 'library-empty-reading-goal',
  'library-empty-reading-stats', 'library-empty-followed-authors',
]);

const readingLibrary = populated([
  'visit-library-reading-all-overview', 'visit-library-reading-all-visibility', 'visit-library-reading-all-rating-context',
  'visit-library-reading-all-reading-goal', 'visit-library-reading-all-reading-stats', 'visit-library-reading-all-followed-authors',
  'visit-library-reading-all-shelf-reading', 'visit-library-reading-all-work-states', 'visit-library-reading-all-resume-work',
]);

const readShelfLibrary = populated([
  'visit-library-read-read-overview', 'visit-library-read-read-visibility', 'visit-library-read-read-rating-context',
  'visit-library-read-read-reading-goal', 'visit-library-read-read-reading-stats', 'visit-library-read-read-shelf-read',
  'visit-library-read-read-work-states', 'visit-library-read-read-import-reviews',
]);

const year = Number(new URL(sample('member', 'visit-library-reading-all-reading-goal').path, 'https://recorded.invalid')
  .searchParams.get('year'));
const member = actingSubject(sample('member', 'visit-library-reading-all-overview').path);
const readingShelf = sample('member', 'visit-library-reading-all-shelf-reading').answer as {
  items: { work: string; card: { title: { value: string } } }[] };
const readingItem = readingShelf.items[0];
const readingTitle = readingItem?.card.title.value;
const readShelf = sample('member', 'visit-library-read-read-shelf-read').answer as {
  items: { work: string; card: { title: { value: string } } }[] };
const readItem = readShelf.items[0];
const readTitle = readItem?.card.title.value;
if (!readingTitle || !readingItem || !readTitle || !readItem) throw new Error('Recorded library shelf has no title');
const workLink = (work: string) => localizedPath(workHref(work.slice(-36)), 'en');

const meta = {
  title: 'Library/Recorded visual novels', component: BooksLibraryRecorded,
  args: { record: collection, persona: 'member' as const, selections: readingLibrary,
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
  const tools = canvas.getByText(messages.libraryTools, { selector: 'summary' });
  await userEvent.click(tools);
  await expect(canvas.getByRole('heading', { level: 2, name: `Reading in ${year}` })).toBeVisible();
  await expect(canvas.getByText('0 chapters completed')).toBeVisible();
  await userEvent.click(tools);
}

/** Member’s recorded shelves before any visual novel is saved. */
export const MemberEmpty: Story = {
  args: { selections: emptyLibrary },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
    await expect(canvas.getByText(works(counts('library-empty-overview').total))).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: 'Your library starts here' })).toBeVisible();
    const tools = canvas.getByText(messages.libraryTools, { selector: 'summary' });
    await userEvent.click(tools);
    await expect(canvas.getByText('Set a goal for books finished this year')).toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: `Reading in ${year}` })).toBeVisible();
    await expect(canvas.getByText('0 chapters completed')).toBeVisible();
    await expect(canvas.getByText('0 books finished')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Who can see your reading shelves: Only you' })).toBeVisible();
    await expect(canvas.queryByRole('navigation', { name: 'Shelves' })).toBeNull();
    await userEvent.click(tools);
    window.scrollTo(0, 0);
  },
};
export const MemberEmptyPhone: Story = { ...MemberEmpty, ...phone };

/** Member’s recorded visual novel on Currently reading, with no chapter to continue. */
export const MemberReading: Story = {
  play: async ({ canvasElement }) => {
    await expectShelfCounts(canvasElement, 'visit-library-reading-all-overview');
    const canvas = within(canvasElement);
    const reading = within(canvas.getByRole('region', { name: 'Currently reading' }));
    await expect(reading.getByRole('heading', { level: 3, name: readingTitle })).toBeVisible();
    const open = reading.getByRole('link', { name: new RegExp(`^Open\\b.*${readingTitle}`) });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute('href', workLink(readingItem.work));
    await expect(reading.queryByText(/Next:/)).toBeNull();
    await expect(reading.getByText('Your progress')).toBeVisible();
    canvas.getByRole('region', { name: 'Currently reading' }).scrollIntoView({ block: 'start' });
  },
};
export const MemberReadingPhone: Story = { ...MemberReading, ...phone };

/** Member’s recorded Read shelf, with the visual novel’s title and played status. */
export const MemberRead: Story = {
  args: { selections: readShelfLibrary, state: parseLibraryState({ shelf: 'read' }) },
  play: async ({ canvasElement }) => {
    await expectShelfCounts(canvasElement, 'visit-library-read-read-overview');
    const canvas = within(canvasElement);
    const shelf = within(canvas.getByRole('region', { name: /^Read(?!ing)/ }));
    const title = shelf.getByRole('heading', { level: 3, name: readTitle });
    await expect(title).toBeVisible();
    await expect(within(title).getByRole('link')).toHaveAttribute('href', workLink(readItem.work));
    await expect(shelf.getByText('Played')).toBeVisible();
    await expect(shelf.getByRole('button', { name: new RegExp(`^Read\\b.*${readTitle}`) })).toBeVisible();
    await expect(canvas.queryByRole('region', { name: 'Currently reading' })).toBeNull();
    canvas.getByRole('region', { name: /^Read(?!ing)/ }).scrollIntoView({ block: 'start' });
  },
};
export const MemberReadPhone: Story = { ...MemberRead, ...phone };

/** The shelf read is held unanswered, so the page stays at its loading status. */
export const MemberLoading: Story = {
  args: { selections: [{ label: 'visit-library-reading-all-overview', state: 'loading' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Loading…');
    await expect(canvas.queryByRole('heading', { name: 'Library' })).toBeNull();
  },
};
export const MemberLoadingPhone: Story = { ...MemberLoading, ...phone };
