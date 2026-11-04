import type { Meta, StoryObj } from '@storybook/react-vite';
import { PatternStory, PageStory } from './page';
import { CollectionPage } from '../library/collection-page';
import { subjectOf } from '../library/reads';
import type { EditableCollectionPage } from '../library/collection-load';
import { collectionStoryMembers } from '../kernel/fake/collection-stories';
import collection from '../kernel/recorded/library-collection.json';

function Example({ layout = 'list', mixed = false }: { layout?: 'list' | 'grid'; mixed?: boolean }) {
  const page: EditableCollectionPage = {
    ...collection.collection,
    visibility: null,
    disclosedVisibility: 'public',
    members: collectionStoryMembers.map((member) => ({ ...member, subject: subjectOf(member.subject) })),
    next: null,
    following: null,
    firstPage: true,
    publicExport: false,
    presentationKind: mixed ? null : 'schema:Book',
    presentationKindSource: mixed ? 'mixed' : 'owner',
  };
  return (
    <PatternStory visitor="Signed Out" path={`/collections/${page.id}${layout === 'grid' ? '?layout=grid' : ''}`}>
      <div className="mx-auto w-full max-w-6xl p-4">
        <CollectionPage
          queryKey={undefined}
          cursor={undefined}
          page={page}
          layout={layout}
          refreshPage={async () => page}
        />
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Library/Collection presentation',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Existing read and editor hosts. Recorded/story data illustrates presentation only; native seeded walkthrough remains separate. Use locale and theme globals at 390 and 1440 pixels.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ordered: Story = { render: () => <Example /> };
export const Grid: Story = { render: () => <Example layout="grid" /> };
export const Mixed: Story = { render: () => <Example mixed /> };
export const Dynamic: Story = { render: () => <PageStory visitor="Signed In" path="/collections/dynamic-state" /> };
