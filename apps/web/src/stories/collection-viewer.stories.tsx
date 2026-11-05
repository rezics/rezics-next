import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionReadMembers } from '../library/collection-page';
import type { CollectionViewerProjection } from '../library/collection-viewer/model';
import { collectionMemberReturnAddress, collectionViewerActionHref } from '../library/collection-viewer/model';
import { subjectHref } from '../subject/subject-href';
import type { CollectionMember } from '../library/reads';

const subjectId = '00000000-0000-4000-8000-000000000111';
const memberIds = [
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000203',
];
const subject: NonNullable<CollectionMember['subject']> = {
  id: subjectId,
  type: 'schema:Book',
  types: ['schema:Book'],
  label: 'The same book',
  cover: null,
};
const members: CollectionMember[] = [
  { id: memberIds[0]!, subjectId, subject, note: 'Curator note: start here.', addedAt: '2026-10-01T00:00:00Z' },
  {
    id: memberIds[1]!,
    subjectId,
    subject,
    note: 'Curator note: a second occurrence.',
    addedAt: '2026-10-02T00:00:00Z',
  },
  { id: memberIds[2]!, subjectId, subject, note: 'Curator note: score is withheld.', addedAt: '2026-10-03T00:00:00Z' },
];
const questionId = '00000000-0000-7000-8000-000000000001';
const projection: CollectionViewerProjection = {
  state: 'current',
  question: {
    id: questionId,
    revision: 1,
    grain: 'item',
    scale: { min: 0, max: 20, displayStep: 1 },
    meaning: 'Your personal rating of this work',
  },
  rows: [
    {
      rowKey: memberIds[0]!,
      subjectId,
      entry: {
        state: 'present',
        incarnationId: '00000000-0000-4000-8000-000000000301',
        entryState: 'in_progress',
        revision: 4,
      },
      vote: { state: 'present', questionId, questionRevision: 1, units: 14, revision: 5 },
    },
    {
      rowKey: memberIds[1]!,
      subjectId,
      entry: { state: 'absent' },
      vote: { state: 'absent', questionId, questionRevision: 1 },
    },
    {
      rowKey: memberIds[2]!,
      subjectId,
      entry: { state: 'unavailable', reason: 'scope' },
      vote: { state: 'unavailable', reason: 'question' },
    },
  ],
};
const collectionHref =
  '/en/collections/00000000-0000-4000-8000-000000000101?cursor=page-two&layout=list&type=schema%3ABook&f.schema%3Agenre=fiction';

function actionHref(member: CollectionMember) {
  if (!member.subject) return undefined;
  const destination = subjectHref({ id: member.subject.id, label: 'The same book' }, 'en').href;
  return collectionViewerActionHref(destination, collectionMemberReturnAddress(collectionHref, member.id));
}

function Showcase({ layout }: { layout: 'grid' | 'list' }) {
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-4" data-reader="non-curator" data-page-cursor="page-two">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Maya’s Collection</h1>
        <p>You are reading as a non-curator · Page 2 · Type: Book · Genre: fiction · another page is available</p>
      </header>
      <CollectionReadMembers
        members={members}
        layout={layout}
        viewerProjection={projection}
        viewerActionHref={actionHref}
        onCopy={() => undefined}
      />
    </main>
  );
}

const meta = {
  title: 'Collections/Personal reading state',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Supplied current native projection: repeated occurrences keep their own IDs and curator notes while their reader facts match by row key and source subject. Review at phone390 and desktop1280.',
      },
    },
  },
} satisfies Meta<typeof CollectionReadMembers>;
export default meta;
type Story = StoryObj<typeof meta>;

async function readingExample(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('heading', { name: 'Maya’s Collection' })).toBeVisible();
  await expect(canvas.getByText('Curator note: start here.')).toBeVisible();
  await expect(canvas.getByText('Curator note: a second occurrence.')).toBeVisible();
  await expect(canvas.getByText('Your rating: 7')).toBeVisible();
  await expect(canvas.getByText('Not in your Library.')).toBeVisible();
  await expect(canvas.getByText('Your personal rating is unavailable.')).toBeVisible();
  await expect(canvas.queryByRole('link', { name: 'Open your Library controls' })).toBeNull();
  await expect(canvas.getAllByText('Your personal controls are unavailable.')).toHaveLength(3);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
}

export const Phone390: Story = {
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  render: () => <Showcase layout="list" />,
  play: async ({ canvasElement }) => readingExample(canvasElement),
};

export const Desktop1280: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  render: () => <Showcase layout="grid" />,
  play: async ({ canvasElement }) => readingExample(canvasElement),
};

function RetiredReader() {
  const [retired, setRetired] = useState(false);
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4">
      <button type="button" className="min-h-11" onClick={() => setRetired(true)}>
        Replace reader
      </button>
      <CollectionReadMembers
        members={members.slice(0, 1)}
        viewerProjection={retired ? { state: 'withheld' } : projection}
        {...(!retired ? { viewerActionHref: actionHref } : {})}
        onCopy={() => undefined}
      />
    </main>
  );
}

export const ReaderReplacement: Story = {
  render: () => <RetiredReader />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Your rating: 7')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Replace reader' }));
    await expect(canvas.queryByText('Your rating: 7')).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'Open your Library controls' })).toBeNull();
    await expect(canvas.getByText('Curator note: start here.')).toBeVisible();
  },
};
