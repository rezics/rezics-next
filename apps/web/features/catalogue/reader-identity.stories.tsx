import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ReaderActionsProvider, ShelfButton, RateWork, useReaderActions } from './reader-actions.tsx';
import type { ReaderSeed } from './reader-store.ts';
import { storyWorkId } from './fixtures.ts';

const work = storyWorkId(1);
const actors = [storyWorkId(101), storyWorkId(102)];
const seeds: ReaderSeed[] = [
  { [work]: { status: 'read', version: 1, rating: { value: 5, revision: storyWorkId(201),
    sourcePosition: { datasetId: 'product', dataEpoch: 'reader-a', sequence: '1' } } } },
  { [work]: { status: 'want-to-read', version: 1, rating: { value: 2, revision: storyWorkId(202),
    sourcePosition: { datasetId: 'product', dataEpoch: 'reader-b', sequence: '1' } } } },
];

function CurrentReader() {
  const actions = useReaderActions();
  return <output aria-label="Current reader state">{actions.kind === 'ready'
    ? JSON.stringify(actions.stateOf(work)) : actions.kind}</output>;
}

function ReaderIdentity() {
  const [reader, setReader] = useState(0);
  return <div className="grid gap-4 p-6">
    <button type="button" onClick={() => setReader(1)}>Switch reader</button>
    <button type="button" onClick={() => setReader(2)}>End session</button>
    <ReaderActionsProvider signedIn={reader < 2} actingSubject={actors[reader]} seed={seeds[reader]}
      signInHref="/auth/start" ratingTarget={{ work, context: storyWorkId(300), mainVersion: storyWorkId(301), max: 5 }}>
      <ShelfButton work={work} title="A book" locale="en" />
      <RateWork work={work} locale="en" />
      <CurrentReader />
    </ReaderActionsProvider>
  </div>;
}

const meta = { title: 'Catalogue/Reader identity', component: ReaderIdentity } satisfies Meta<typeof ReaderIdentity>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SwitchAndSignOut: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByLabelText('Current reader state')).toHaveTextContent('"rating":5');
  await userEvent.click(canvas.getByRole('button', { name: 'Switch reader' }));
  await expect(canvas.getByLabelText('Current reader state')).toHaveTextContent('"status":"want-to-read","rating":2');
  await userEvent.click(canvas.getByRole('button', { name: 'End session' }));
  await expect(canvas.getByLabelText('Current reader state')).toHaveTextContent('signed-out');
  await expect(canvas.getByRole('link', { name: /Sign in to keep a reading list/ })).toBeVisible();
} };
