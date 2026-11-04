import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import { OwnMediaInventoryWorkspace } from '../media/own-inventory/page';
import { OWN_MEDIA_SOURCE } from '../media/own-inventory/inventory';
import type { OwnMediaRead } from '../media/own-inventory/actions';
import type { OwnMediaInventoryEntry, OwnMediaInventoryPage } from '../media/own-inventory/wire';

const meta = {
  title: 'Library/My uploaded media',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const viewer = '01a1a3b1-b7d4-7736-9cd2-2200583c3cf5';
const thread = '01a1a3b1-b7d4-7737-8f31-22005e04f73c';
const mediaIds = [
  '01a1a3b1-b7d4-7738-9f8b-2200fe3e8395',
  '01a1a3b1-b7d4-7739-a334-220004d0d2e0',
  '01a1a3b1-b7d4-773a-bc22-2200fba1b4d3',
  '01a1a3b1-b7d4-773b-a186-22003cb5a32c',
  '01a1a3b1-b7d4-773c-9a26-2200b24b839c',
];

function entry(
  id: string,
  state: OwnMediaInventoryEntry['state'],
  options: { withheld?: boolean; longType?: boolean } = {},
): OwnMediaInventoryEntry {
  const readable = state === 'available' && !options.withheld;
  return {
    id,
    purpose: 'post-image',
    state,
    declaredMediaType: options.longType ? 'image/vnd.example.very-long-declared-media-kind' : 'image/png',
    actualMediaType: null,
    declaredByteCount: 14832,
    actualByteCount: state === 'available' ? 14832 : null,
    createdAt: '2026-10-01T00:00:00.000Z',
    claimedAt: state === 'available' ? '2026-10-02T12:30:00.000Z' : null,
    collectionPending: false,
    takenDown: false,
    container: options.withheld ? null : { id: thread, kind: 'thread' },
    actions: {
      read: readable
        ? { operationId: 'media.authorize_download', variants: ['original', 'webp-320'], recheckAtUse: true }
        : null,
      remove: state === 'erased' ? null : { operationId: 'media.erase' },
      resume:
        state === 'reserved' || state === 'uploaded'
          ? {
              operationId: 'media.read_reservation',
              mode: state === 'reserved' ? 'same-reservation' : 'processing',
              requiresOriginalFile: true,
            }
          : null,
      retry: state === 'rejected' ? { operationId: 'media.create', guidance: 'choose-new-file' } : null,
    },
  };
}

function page(entries: OwnMediaInventoryEntry[], nextCursor: string | null = null): OwnMediaInventoryPage {
  return { availability: 'available', entries, nextCursor };
}

function StoryRouter({
  inventory,
  onErase = async () => 'uncertain',
}: {
  inventory: OwnMediaRead;
  onErase?: (input: {
    data: import('../media/own-inventory/inventory').OwnMediaEraseIntent;
  }) => Promise<'acknowledged' | 'signed-out' | 'stale' | 'denied' | 'concealed' | 'uncertain'>;
}) {
  const router = useMemo(() => {
    const root = createRootRoute({ component: Outlet });
    const mediaRoute = createRoute({
      getParentRoute: () => root,
      path: '/library/media',
      validateSearch: (search: Record<string, unknown>) => search as { cursor?: string },
      component: () => (
        <OwnMediaInventoryWorkspace
          state={inventory.state}
          page={inventory.page}
          cursor={inventory.cursor}
          subject={inventory.subject}
          locale={inventory.locale}
          viewKey="storybook"
          isCurrent={() => true}
          onRefresh={async () => undefined}
          onErase={onErase}
        />
      ),
    });
    const threadRoute = createRoute({
      getParentRoute: () => root,
      path: '/threads/$id',
      component: () => <p className="p-8">Thread destination</p>,
    });
    const realmRoute = createRoute({
      getParentRoute: () => root,
      path: '/realms/$id',
      component: () => <p className="p-8">Realm destination</p>,
    });
    return createRouter({
      routeTree: root.addChildren([mediaRoute, threadRoute, realmRoute]),
      history: createMemoryHistory({ initialEntries: ['/library/media'] }),
    });
  }, []);
  return <RouterProvider router={router} />;
}

function read(state: OwnMediaRead['state'], current: OwnMediaInventoryPage | null): OwnMediaRead {
  return {
    state,
    page: current,
    subject: viewer,
    cursor: null,
    locale: 'en',
    source: state === 'ready' ? OWN_MEDIA_SOURCE : null,
  };
}

export const Empty: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <StoryRouter inventory={read('ready', page([]))} />,
};

export const SparseContinuation: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <StoryRouter inventory={read('ready', page([], 'opaque-next-cursor'))} />,
};

export const MixedLifecycleDesktop: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => (
    <StoryRouter
      inventory={read(
        'ready',
        page([
          entry(mediaIds[0]!, 'reserved'),
          entry(mediaIds[1]!, 'uploaded'),
          entry(mediaIds[2]!, 'available'),
          entry(mediaIds[3]!, 'rejected'),
          entry(mediaIds[4]!, 'erased'),
        ]),
      )}
    />
  ),
};

export const WithheldAndLongTextPhone: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false }, locale: 'zh-Hant' },
  render: () => (
    <StoryRouter
      inventory={read('ready', page([entry(mediaIds[2]!, 'available', { withheld: true, longType: true })]))}
    />
  ),
};

export const UnknownRemovalKeyboard: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <StoryRouter inventory={read('ready', page([entry(mediaIds[2]!, 'available')]))} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: /post image.*ready/i })).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: /post image.*ready/i }));
    await userEvent.click(canvas.getByRole('button', { name: /remove this media/i }));
    await userEvent.click(canvas.getByRole('button', { name: /confirm removal/i }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(/removal is not confirmed/i);
    await expect(canvas.getByRole('button', { name: /retry original removal/i })).toBeVisible();
  },
};

export const SessionPreparing: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <StoryRouter inventory={read('preparing', null)} />,
};

export const DependencyFailure: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <StoryRouter inventory={read('unavailable', null)} />,
};

export const UnresolvedRemoval: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <StoryRouter inventory={read('ready', page([
    entry(mediaIds[0]!, 'available'), entry(mediaIds[1]!, 'uploaded'),
  ]))} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /post image.*ready/i }));
    await userEvent.click(canvas.getByRole('button', { name: /remove this media/i }));
    await userEvent.click(canvas.getByRole('button', { name: /confirm removal/i }));
    await userEvent.click(canvas.getByRole('button', { name: /post image.*uploaded/i }));
    await expect(canvas.getByRole('alert')).toHaveTextContent(mediaIds[0]!);
    await expect(canvas.getByRole('button', { name: /retry original removal/i })).toBeEnabled();
  },
};

export const UnresolvedRemovalPhone: Story = {
  ...UnresolvedRemoval,
  globals: { viewport: { value: 'phone390', isRotated: false } },
};
