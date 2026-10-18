import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/games/collection-tracking-and-progress.json';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { BooksLibraryRecorded } from './books-library-recorded-page.tsx';
import { messages } from './messages.ts';

// The library reader asks for three currently-reading works (`limit=3`). This
// record's currently-reading page asks for six, so those titles are not drawn.
// No recorded answer is an empty collection, or a library refusal at the
// reader's shelf query, so those states are not drawn.

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

const memberShelves = sample('member', 'library-overview');
const memberAgent = actingSubject(memberShelves.path);
const memberLibrary: RecordedSelection[] = [
  { label: 'library-overview', state: 'populated' },
  { label: 'library-visibility', state: 'populated' },
  { label: 'library-rating-context', state: 'populated' },
  { label: 'reading-goal', state: 'populated' },
  { label: 'reading-year', state: 'populated' },
  { label: 'followed-authors', state: 'empty' },
];

const meta = {
  title: 'Library/Recorded games', component: BooksLibraryRecorded,
  args: { record: collection, persona: 'member' as const, selections: memberLibrary, actingSubject: memberAgent, year: 2026 },
  parameters: { controls: { disable: true }, route: { pathname: '/en/library' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof BooksLibraryRecorded>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { globals: { viewport: { value: 'phone' as const } } };

async function expectMemberLibrary(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await expect(canvas.getByText('3 works')).toBeVisible();
  const shelves = within(canvas.getByRole('navigation', { name: 'Shelves' }));
  await expect(shelves.getByRole('link', { name: 'All 3' })).toBeVisible();
  await expect(shelves.getByRole('link', { name: 'Currently reading 2' })).toBeVisible();
  await expect(shelves.getByRole('link', { name: 'Want to read 1' })).toBeVisible();
  await expect(shelves.getByRole('link', { name: 'Read 0' })).toBeVisible();
  await expect(canvas.getByRole('button', { name: 'Who can see your reading shelves: Only you' })).toBeVisible();
  const tools = canvas.getByText(messages.libraryTools, { selector: 'summary' });
  await userEvent.click(tools);
  await expect(canvas.getByRole('heading', { level: 2, name: '2026 reading goal' })).toBeVisible();
  await expect(canvas.getByText('Set a goal for books finished this year')).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 2, name: 'Reading in 2026' })).toBeVisible();
  await expect(canvas.getByText('0 books finished')).toBeVisible();
  await expect(canvas.getByText('2 chapters completed')).toBeVisible();
  await expect(canvas.queryByRole('heading', { name: 'Authors you follow' })).toBeNull();
  await expect(canvas.queryByRole('region', { name: 'Currently reading' })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: 'Original garden with main and bonus routes' })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: 'Original neighbouring garden game' })).toBeNull();
  await userEvent.click(tools);
  window.scrollTo(0, 0);
}

/** Member’s recorded shelf counts, private library and chapter year. */
export const MemberPopulated: Story = { play: async ({ canvasElement }) => { await expectMemberLibrary(canvasElement); } };
export const MemberPopulatedPhone: Story = { ...MemberPopulated, ...phone };

/** The shelf read is held unanswered, so the page stays at its loading status. */
export const MemberLoading: Story = {
  args: { selections: [{ label: 'library-overview', state: 'loading' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Loading…');
    await expect(canvas.queryByRole('heading', { name: 'Library' })).toBeNull();
  },
};
export const MemberLoadingPhone: Story = { ...MemberLoading, ...phone };
