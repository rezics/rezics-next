import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import realmBoardsRecording from '../kernel/recorded/realm-boards.json';
import spaceRecording from '../kernel/recorded/space.json';
import { PageStory, pageReady } from './page';
import { m } from '../paraglide/messages.js';
import { communityCurrentClaimStory } from './community-current-claim';

const meta = {
  title: 'Community/Space',
  id: 'pages-community-space',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'One native community identity with adjacent Follow and Join/Leave, then boards and published subjects. A distinct routed Space stays compact context. Manage community requires current native operation admission after hydration; an old private cache cannot grant an SSR entry. Signed In exercises the mounted default page through the native setup reader and session provenance, while Signed Out and Member withhold management. Controls remain mounted when closed and reset for a changed viewer or Realm. Public readers see no private management dashboards.',
      },
    },
  },
  beforeEach: communityCurrentClaimStory,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

let setupReads = 0;

/** Native wire illustration only: the default page still prepares its session and runs readSetup itself. */
function setupActionsStory(operations: 'space_address.change'[]) {
  return () => {
    setupReads = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://rezics.local');
      if (url.origin !== 'http://kernel.local' || url.pathname !== '/v1/viewerActions') return previous(input, init);
      const request = new Request(input, init);
      if (request.method !== 'POST') return previous(input, init);
      const { resources } = (await request.clone().json()) as { resources: { type: string; id: string }[] };
      if (
        resources.length !== 2 ||
        !resources.some(
          (resource) => resource.type === 'community.space' && resource.id === spaceRecording.space.spaceId,
        ) ||
        !resources.some(
          (resource) => resource.type === 'community.realm' && resource.id === spaceRecording.space.realmId,
        )
      )
        return previous(input, init);
      setupReads++;
      return Response.json({
        resources: resources.map((resource) => ({
          ...resource,
          viewerActions:
            request.headers.get('authorization') === 'Bearer recorded-story-token' &&
            resource.type === 'community.space' &&
            operations.length > 0
              ? [{ action: 'space:manage', operations }]
              : [],
        })),
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = previous;
    };
  };
}

/** The Space's title, the Realm's boards and a published subject are on the page. */
async function spaceReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: spaceRecording.space.title });
  await expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  await expect(context.canvasElement.querySelectorAll('[data-slot="realm-home-presentation"]')).toHaveLength(1);
  const board = realmBoardsRecording.items[0]?.title;
  if (!board) throw new Error('The recorded Realm has no board.');
  await view.findByRole('link', { name: new RegExp(board) });
  await expect(view.queryByRole('heading', { name: m.realm_appearance_heading() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.realm_bans_heading() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.realm_claim_heading() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.container_lifecycle_space() })).toBeNull();
  await expect(view.queryByRole('heading', { name: m.container_lifecycle_realm() })).toBeNull();
  const firstRow = (await view.findAllByRole('listitem'))[0]!;
  await userEvent.hover(firstRow);
  firstRow.setAttribute('data-overlay', 'visible');
}

export const SignedIn: Story = {
  name: 'Banner, Non-member with setup admission',
  beforeEach: setupActionsStory(['space_address.change']),
  play: async (context) => {
    await spaceReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const view = within(main);
    const entry = await view.findByRole('button', { name: m.community_manage() });
    await expect(entry).toHaveAttribute('aria-expanded', 'false');
    const destination = main.ownerDocument.getElementById(entry.getAttribute('aria-controls')!);
    if (!destination || !main.contains(destination)) throw new Error('Management has no destination on this page.');
    await expect(destination).not.toBeVisible();
    await waitFor(() => expect(setupReads).toBe(1));
    await userEvent.click(entry);
    await expect(entry).toHaveAttribute('aria-expanded', 'true');
    await expect(await within(destination).findByRole('link', { name: m.space_setup_entry() })).toBeVisible();
    await expect(view.queryByRole('heading', { name: m.realm_appearance_heading() })).toBeNull();
    await expect(view.queryByRole('heading', { name: m.realm_bans_heading() })).toBeNull();
    await userEvent.click(within(destination).getByRole('button', { name: m.community_manage_close() }));
    await expect(destination).not.toBeVisible();
    await userEvent.click(entry);
    await expect(main.ownerDocument.getElementById(entry.getAttribute('aria-controls')!)).toBe(destination);
    await expect(within(destination).getByRole('link', { name: m.space_setup_entry() })).toBeVisible();
    await expect(setupReads).toBe(1);
  },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-non-member" />,
};
export const SignedOut: Story = {
  name: 'Banner, Signed Out',
  play: async (context) => {
    await spaceReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    await expect(view.queryByRole('button', { name: m.community_manage() })).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-banner" />,
};
export const NoBanner: Story = {
  name: 'No Banner',
  play: spaceReady,
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-plain" />,
};
export const Member: Story = {
  name: 'Banner, Member',
  beforeEach: setupActionsStory([]),
  play: async (context) => {
    await spaceReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const membership = within(view.getByRole('region', { name: m.realm_membership_label() }));
    await expect(await membership.findByRole('button', { name: m.realm_leave() })).toBeEnabled();
    await expect(membership.getByText(m.realm_state_member())).toBeVisible();
    await expect(membership.queryByRole('button', { name: m.realm_join() })).toBeNull();
    await waitFor(() => expect(setupReads).toBe(1));
    await expect(view.queryByRole('button', { name: m.community_manage() })).toBeNull();
    for (const board of realmBoardsRecording.items)
      await expect(view.getByRole('link', { name: board.title })).toBeVisible();
    await expect(view.getByRole('heading', { name: m.realm_published_heading() })).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_curate() }));
    await expect(view.getByRole('button', { name: m.realm_publication_publish() })).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.realm_publication_curate() }));
  },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-member" />,
};

export const Unavailable: Story = {
  name: 'Membership and published subject unavailable',
  play: async (context) => {
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 1, name: spaceRecording.space.title });
    const board = realmBoardsRecording.items[0]?.title;
    if (!board) throw new Error('The recorded Realm has no board.');
    await view.findByRole('link', { name: new RegExp(board) });
    await view.findByRole('heading', { level: 2, name: m.realm_published_heading() });
    const membership = within(view.getByRole('region', { name: m.realm_membership_label() }));
    await expect(await membership.findByRole('status')).toHaveTextContent(m.realm_membership_unavailable());
    await expect(view.queryByRole('button', { name: m.realm_join() })).toBeNull();
    await expect(view.getByText(m.realm_published_unavailable())).toBeVisible();
    await expect(view.queryByText(m.realm_published_empty())).toBeNull();
  },
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-unavailable" />,
};

/** An unavailable board-list response becomes an error page, not a false empty state. */
export const BoardsUnavailable: Story = {
  name: 'Boards request unavailable',
  play: async (context) => {
    const view = within(within(context.canvasElement).getByRole('main'));
    await view.findByRole('heading', { level: 1, name: m.error_heading() });
    await expect(view.queryByText(m.realm_boards_empty())).toBeNull();
    await expect(
      view.queryByRole('link', { name: new RegExp(realmBoardsRecording.items[0]?.title ?? 'missing') }),
    ).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-boards-unavailable" />,
};
