import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { useState } from 'react';
import { Button } from '@rezics/ui/button';
import type { MediaImageViewer } from '@rezics/ui/media-image';
import { WebRatedContent, WebRatedContentProvider } from './rated-content.tsx';
import type { ContentRatings } from '../api/content-rating.ts';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const viewer: MediaImageViewer = { ready: true, signedIn: true, age: 'adult', nsfwDisplay: 'show',
  optIns: { general: true, r15: true, sexual: true, grotesque: false } };
const read = fn(async () => ({ [target]: { status: 'assessed' as const, labels: ['r18', 'r18g'] as const } }));

function CategoryChoice() {
  const [current, setCurrent] = useState(viewer);
  return <WebRatedContentProvider viewer={current} locale="en" resolve={read}>
    <div className="mx-auto max-w-lg space-y-4 p-6">
      <Button onClick={() => setCurrent({ ...viewer, optIns: { ...viewer.optIns, grotesque: true } })}>
        Enable R18G
      </Button>
      <WebRatedContent target={target}><p>Rated body text</p></WebRatedContent>
      <WebRatedContent target={target}><p>Another rendering of the same body</p></WebRatedContent>
    </div>
  </WebRatedContentProvider>;
}

const meta = { title: 'Content/Rated body', component: WebRatedContent, args: { children: null },
  render: () => <CategoryChoice />,
} satisfies Meta<typeof WebRatedContent>;
export default meta;
type Story = StoryObj<typeof meta>;

export const IndependentCategoriesAndSharedBatch: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByText('This content is hidden by your age rating preferences.')).toHaveLength(2);
    await expect(canvas.queryByText('Rated body text')).toBeNull();
    await expect(read).toHaveBeenCalledTimes(1);
    await expect(read).toHaveBeenCalledWith([target]);
    await userEvent.click(canvas.getByRole('button', { name: 'Enable R18G' }));
    await expect(await canvas.findByText('Rated body text')).toBeVisible();
    await expect(canvas.getByText('Another rendering of the same body')).toBeVisible();
    await expect(read).toHaveBeenCalledTimes(1);
  },
};

export const UnknownAssessmentKeepsItsOwnState: Story = {
  render: () => <WebRatedContentProvider viewer={{ ...viewer, optIns: { ...viewer.optIns, general: false } }}
    locale="en" resolve={async () => ({ [target]: { status: 'unassessed' } })}>
    <div className="max-w-lg p-6"><WebRatedContent target={target}><p>Unassessed body text</p></WebRatedContent></div>
  </WebRatedContentProvider>,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('Unassessed body text')).toBeVisible();
  },
};

export const UnavailableAssessment: Story = {
  render: () => <WebRatedContentProvider viewer={viewer} locale="en" resolve={async () => { throw new Error('Offline'); }}>
    <div className="max-w-lg p-6"><WebRatedContent target={target}><p>Unavailable body text</p></WebRatedContent></div>
  </WebRatedContentProvider>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Content unavailable')).toBeVisible();
    await expect(canvas.queryByText('Unavailable body text')).toBeNull();
  },
};

export const StandalonePreview: Story = {
  render: () => <div className="max-w-lg p-6"><WebRatedContent target={target}><p>Standalone body preview</p></WebRatedContent></div>,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText('Standalone body preview')).toBeVisible();
  },
};

let releaseOldRating: ((ratings: ContentRatings) => void) | undefined;
const refreshedRead = fn(async (): Promise<ContentRatings> => {
  if (refreshedRead.mock.calls.length === 1) return new Promise(resolve => { releaseOldRating = resolve; });
  return { [target]: { status: 'assessed', labels: ['r18g'] } };
});
function LocalDraft() {
  const [draft, setDraft] = useState('');
  return <label className="grid gap-2">Unsent draft<input value={draft} onChange={event => setDraft(event.currentTarget.value)}
    className="rounded-md border border-input bg-background px-3 py-2" /></label>;
}
function RefreshRatings() {
  const [refreshKey, setRefreshKey] = useState(0);
  return <WebRatedContentProvider viewer={viewer} locale="en" resolve={refreshedRead} refreshKey={refreshKey}>
    <div className="mx-auto max-w-lg space-y-4 p-6"><LocalDraft />
      <Button onClick={() => setRefreshKey(value => value + 1)}>Refresh viewing state</Button>
      <WebRatedContent target={target}><p>Restricted refreshed body</p></WebRatedContent>
    </div>
  </WebRatedContentProvider>;
}
export const RefreshPreservesDraftAndRejectsOldRead: Story = {
  render: () => <RefreshRatings />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(refreshedRead).toHaveBeenCalledTimes(1));
    const input = canvas.getByRole('textbox', { name: 'Unsent draft' });
    await userEvent.type(input, 'Keep this unsent text');
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh viewing state' }));
    await expect(await canvas.findByText('This content is hidden by your age rating preferences.')).toBeVisible();
    await expect(refreshedRead).toHaveBeenCalledTimes(2);
    await expect(canvas.getByRole('textbox', { name: 'Unsent draft' })).toBe(input);
    await expect(input).toHaveValue('Keep this unsent text');
    releaseOldRating!({ [target]: { status: 'assessed', labels: [] } });
    await refreshedRead.mock.results[0]!.value;
    await userEvent.click(input);
    await waitFor(() => expect(canvas.queryByText('Restricted refreshed body')).toBeNull());
    await expect(canvas.getByText('This content is hidden by your age rating preferences.')).toBeVisible();
    await expect(input).toHaveValue('Keep this unsent text');
  },
};
