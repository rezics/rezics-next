import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionMetadataHistory } from '../library/collection-metadata-history-view';
import type {
  CollectionMetadataHistoryPage,
  CollectionMetadataHistorySource,
} from '../library/collection-metadata-history';
import { m } from '../paraglide/messages.js';

const basis = {
  collectionRevision: 9,
  curatorAccountId: 'curator',
  viewerAccountId: 'curator',
  authnEpoch: 2,
  minimumAuthnEpoch: '1',
};
const recordedAt = '2026-10-31T10:11:12.123456Z';
const source: CollectionMetadataHistorySource = {
  readPage: async () => ({
    state: 'available',
    value: {
      collectionId: 'collection',
      basis,
      coverage: { coverage: 'partial', knownFromRevision: 2, prunedBeforeRevision: 3 },
      items: [9, 7].map((revision) => ({
        revision,
        recordedAt,
        changedFields: ['title', 'description', 'visibility', 'coverMediaId'],
      })),
      next: null,
      actions: { review: true, reapply: false },
    } satisfies CollectionMetadataHistoryPage,
  }),
  readChange: async ({ revision }) => ({
    state: 'available',
    value: {
      collectionId: 'collection',
      revision,
      recordedAt,
      basis,
      changedFields: ['title', 'description', 'visibility', 'coverMediaId'],
      before: {
        title: 'Reading list',
        description: 'First paragraph.\n\nOriginal second paragraph.',
        visibility: 'private',
        presentationKind: null,
        cover: { state: 'none' },
      },
      after: {
        title: revision === 9 ? 'Books for winter' : 'Reading list for autumn',
        description: 'First paragraph.\n\nRevised second paragraph.',
        visibility: 'public',
        presentationKind: 'schema:Book',
        cover: { state: 'unavailable' },
      },
      actions: { review: true, reapply: false },
    },
  }),
};
const current = () => true;
function Review() {
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-8">
      <CollectionMetadataHistory collectionId="collection" isCurrent={current} source={source} />
    </main>
  );
}
const meta = {
  title: 'Library/Collection metadata history',
  id: 'interfaces-library-collection-metadata-history',
  component: Review,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Curator metadata comparison with constructed retained revisions and an unavailable historical cover.',
      },
    },
  },
} satisfies Meta<typeof Review>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AddressedComparison: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(m.library_collection_metadata_history(), { selector: 'summary' }));
    for (const revision of [9, 7])
      await userEvent.click(
        await canvas.findByRole('checkbox', { name: m.library_collection_metadata_history_select({ revision }) }),
      );
    await userEvent.click(canvas.getByRole('button', { name: m.library_collection_metadata_history_compare() }));
    await expect(await canvas.findByRole('table')).toBeVisible();
    await expect(canvas.getByText('Books for winter')).toBeVisible();
  },
};
