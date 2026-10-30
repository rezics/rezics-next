import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { RealmHomeHeader } from '../community/realm-home-header';
import { RealmMembership } from '../community/realm-membership';
import { loadSpacePage } from '../community/space';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { appearanceAddress, appearancePath, available, appearanceRecording, configured } from '../kernel/fake/community';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

type SourceState = 'available' | 'no-images' | 'optional-unavailable' | 'unavailable' | 'denied';

function Home({ state }: { state: SourceState }) {
  const query = useQuery({
    queryKey: ['realm-home-pattern', state],
    queryFn: async () => {
      const recorded = createStoryRecordedKernelFetch();
      const client = createKernelClient('https://kernel.story', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === `/v1/realms/${available.realmId}/presentation`) {
            if (state === 'unavailable' || state === 'denied') return new Response(null, { status: state === 'denied' ? 403 : 503 });
          }
          if (state === 'no-images' || state === 'optional-unavailable') {
            const snapshot = state === 'no-images' ? configured : {
              ...available,
              avatar: { state: 'unavailable', value: null } as const,
              banner: { state: 'unavailable', value: null } as const,
              rules: { state: 'unavailable', value: null } as const,
            };
            const response = await appearanceRecording(request, snapshot);
            if (response) return Response.json(response);
          }
          return recorded(request);
        }) as typeof fetch,
      });
      return loadSpacePage(client, new Request(`https://site.story${appearancePath}`), {}, { address: appearanceAddress }, 'anonymous');
    },
  });
  if (!query.data?.realm) return <p role="status">{m.realm_shelf_unavailable()}</p>;
  const realm = query.data.realm;
  return <RealmHomeHeader realm={realm} participation={<RealmMembership realm={realm} returnTo={`/${getLocale()}${appearancePath}`} />} />;
}

const meta = {
  title: 'Patterns/Community/Realm Home Presentation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const example = (state: SourceState) => <PatternStory path={appearancePath}><div className="mx-auto max-w-5xl p-4 sm:p-8"><Home state={state} /></div></PatternStory>;

// The existing native-shaped recordings contain unknown members, never an invented total.
export const Available: Story = {
  render: () => example('available'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.board_community_members_unknown())).toBeVisible();
    await expect(await view.findByText('Discuss the work, respect other readers, and mark spoilers.')).toBeVisible();
  },
};
export const WithoutImages: Story = { render: () => example('no-images') };
export const OptionalUnavailable: Story = { render: () => example('optional-unavailable') };
export const SourceUnavailable: Story = { render: () => example('unavailable') };
export const CurrentDenied: Story = { render: () => example('denied') };
