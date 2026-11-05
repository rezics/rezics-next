import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { useQuery } from '@tanstack/react-query';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { RealmHomeHeader } from '../community/realm-home-header';
import { RealmMembership } from '../community/realm-membership';
import { loadSpacePage } from '../community/space';
import { SpacePage } from '../community/space-page';
import type { RealmClaimAdapter } from '../community/realm-claim';
import { readRealmClaim, writeRealmClaim } from '../community/realm-claim-native';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import {
  appearanceAddress,
  appearancePath,
  available,
  appearanceRecording,
  configured,
} from '../kernel/fake/community';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PatternStory } from './page';

type SourceState =
  | 'available'
  | 'no-images'
  | 'optional-unavailable'
  | 'unavailable'
  | 'denied'
  | 'orphan-readable'
  | 'orphan-protected-denied'
  | 'orphan-removed'
  | 'orphan-optional-unavailable';
type NativeRealm = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['realms']>['get']>>['data']>['realm'];

function Home({ state }: { state: SourceState }) {
  const orphan = state.startsWith('orphan-');
  const query = useQuery({
    queryKey: ['realm-home-pattern', state],
    queryFn: async () => {
      const recorded = createStoryRecordedKernelFetch();
      let realmReads = 0;
      const client = createKernelClient('https://kernel.story', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (orphan && path === `/v1/realms/${available.realmId}`) {
            // Actual denial or removal replaces the read; ownership never grants a public response.
            if (state === 'orphan-protected-denied' || (state === 'orphan-removed' && realmReads++ > 0))
              return Response.json({ code: 'not_found' }, { status: 404 });
            const response = await appearanceRecording(request);
            return Response.json({
              ...response,
              realm: {
                ...(response!.realm as NativeRealm),
                ownershipState: 'orphaned',
                orphanedAt: '2026-09-01T00:00:00.000Z',
                claimEligibleAt: '2026-10-01T00:00:00.000Z',
                governanceReadOnly: true,
              } satisfies NativeRealm,
            });
          }
          if (path === `/v1/realms/${available.realmId}/presentation`) {
            if (state === 'unavailable' || state === 'denied')
              return new Response(null, { status: state === 'denied' ? 403 : 503 });
          }
          if (state === 'no-images' || state === 'optional-unavailable' || state === 'orphan-optional-unavailable') {
            const snapshot =
              state === 'no-images'
                ? configured
                : {
                    ...available,
                    avatar: {
                      state: state === 'orphan-optional-unavailable' ? 'none' : 'unavailable',
                      value: null,
                    } as const,
                    banner: { state: 'unavailable', value: null } as const,
                    rules: { state: 'unavailable', value: null } as const,
                  };
            const response = await appearanceRecording(request, snapshot);
            if (response) return Response.json(response);
          }
          return recorded(request);
        }) as typeof fetch,
      });
      const request = new Request(`https://site.story${appearancePath}`);
      const page = await loadSpacePage(client, request, {}, { address: appearanceAddress }, 'anonymous');
      // The existing claim consumer reads these same native responses; it adds no constructed admission.
      const claimAdapter: RealmClaimAdapter = {
        read: (realmId) => readRealmClaim(client, request, {}, { realmId, credentialMode: 'anonymous' }),
        request: (input) => writeRealmClaim(client, request, {}, input),
      };
      return { page, claimAdapter };
    },
  });
  if (!query.data) return <p role="status">{m.realm_shelf_unavailable()}</p>;
  if (orphan) return <SpacePage page={query.data.page} realmClaimAdapter={query.data.claimAdapter} />;
  const realm = query.data.page.realm;
  if (!realm) return <p role="status">{m.realm_shelf_unavailable()}</p>;
  return (
    <RealmHomeHeader
      realm={realm}
      participation={<RealmMembership realm={realm} returnTo={`/${getLocale()}${appearancePath}`} />}
    />
  );
}

const meta = {
  title: 'Patterns/Community/Realm Home Presentation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const example = (state: SourceState) => (
  <PatternStory path={appearancePath}>
    <div className="mx-auto max-w-5xl p-4 sm:p-8">
      <Home state={state} />
    </div>
  </PatternStory>
);

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

export const OrphanReadable: Story = {
  render: () => example('orphan-readable'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('heading', { name: available.title, level: 2 })).toBeVisible();
    await expect(await view.findByText(m.board_community_members_unknown())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_join() })).not.toBeInTheDocument();
    await expect(view.queryByRole('link', { name: m.realm_join() })).not.toBeInTheDocument();
    await expect(view.queryByText(m.space_setup_entry())).not.toBeInTheDocument();
    await expect(view.queryByText(m.realm_appearance_heading())).not.toBeInTheDocument();
  },
};
export const OrphanProtectedDenied: Story = { render: () => example('orphan-protected-denied') };
export const OrphanRemoved: Story = { render: () => example('orphan-removed') };
export const OrphanOptionalUnavailable: Story = {
  render: () => example('orphan-optional-unavailable'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.realm_appearance_no_image())).toBeVisible();
    await expect(view.getByText(m.realm_appearance_image_unavailable())).toBeVisible();
    await expect(view.getByText(m.board_community_rules_unavailable())).toBeVisible();
    await expect(view.getByText(m.board_community_members_unknown())).toBeVisible();
  },
};
