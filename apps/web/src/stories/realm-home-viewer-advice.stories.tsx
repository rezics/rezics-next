import type { Meta, StoryObj } from '@storybook/react-vite';
import type { NativeRealmHomePage } from '../community/realm-home-native';
import { RealmMembership } from '../community/realm-membership';
import { appearancePath } from '../kernel/fake/community';
import { PatternStory } from './page';

const realm = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000001', visibility: 'public' as const, viewer: null };
type ViewerCase = 'member' | 'denied' | 'banned' | 'orphaned';

function observation(kind: ViewerCase): Pick<NativeRealmHomePage, 'viewer' | 'actions'> {
  if (kind === 'member')
    return {
      viewer: { state: 'member', membership: 'member' },
      actions: {
        participate: 'admitted',
        join: 'unavailable',
        leave: 'admitted',
        claim: 'unavailable',
        manage: 'admitted',
      },
    };
  return {
    viewer: { state: kind },
    actions: {
      participate: kind,
      join: kind,
      leave: kind,
      claim: kind,
      manage: kind,
    },
  };
}

function ViewerAdvice({ kind }: { kind: ViewerCase }) {
  return (
    <PatternStory path={appearancePath}>
      <div className="min-w-0 max-w-[390px] p-4" data-viewer-case={kind}>
        <RealmMembership realm={realm} returnTo={appearancePath} nativeObservation={observation(kind)} />
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Patterns/Community/Realm Home Viewer Advice',
  component: ViewerAdvice,
  args: { kind: 'member' },
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof ViewerAdvice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Member: Story = { args: { kind: 'member' } };
export const Denied: Story = { args: { kind: 'denied' } };
export const Banned: Story = { args: { kind: 'banned' } };
export const Orphaned: Story = { args: { kind: 'orphaned' } };
