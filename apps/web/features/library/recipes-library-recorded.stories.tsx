import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/recipes/collection-tracking-and-progress.json';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { BooksLibraryRecorded } from './books-library-recorded-page.tsx';
import { messages } from './messages.ts';
import ja from './messages/ja.ts';

// Shelf names, the reading preview and a collection’s recipe rows are not drawn.
// The route asks for `/v1/me/shelves` with `limit=20`, for the reading shelf
// `status/reading?sort=last-read&order=desc&limit=3`, and for a collection with
// `limit=20`. This record’s shelf directory and collection reads omit `limit`,
// and it has no reading preview. The visibility read can be held unanswered,
// which is the loading status the route reaches from a recorded answer.

const collection = collectionRecord as AnswerRecord;

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

const ownerLibrary = sample(collection, 'owner', 'library-reading-goal');
const ownerAgent = actingSubject(ownerLibrary.path);
const ownerLoading: RecordedSelection[] = [{ label: 'library-visibility', state: 'loading' }];

const meta = {
  title: 'Library/Recorded recipes', component: BooksLibraryRecorded,
  args: { record: collection, persona: 'owner' as const, selections: ownerLoading, actingSubject: ownerAgent, year: 2026 },
  parameters: { controls: { disable: true }, route: { pathname: '/en/library' } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof BooksLibraryRecorded>;
export default meta;
type Story = StoryObj<typeof meta>;

const phone = { globals: { viewport: { value: 'phone' as const } } };

/** Visibility is held unanswered, so the page stays at its loading status. */
export const OwnerLoading: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('status')).toHaveTextContent('Loading…');
    await expect(canvas.queryByRole('heading', { name: 'Library' })).toBeNull();
  },
};
export const OwnerLoadingPhone: Story = { ...OwnerLoading, ...phone };
export const OwnerLoadingWide: Story = { ...OwnerLoading, globals: { viewport: { value: 'desktop1440' } } };
export const JapaneseLoadingPhone: Story = {
  args: { locale: 'ja', messages: { ...messages, ...ja } },
  globals: { locale: 'ja', viewport: { value: 'phone' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByRole('status')).resolves.toHaveTextContent(ja.loading);
  },
};
export const JapaneseLoadingWide: Story = { ...JapaneseLoadingPhone, globals: { locale: 'ja', viewport: { value: 'desktop1440' } } };
