import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { KnowledgeNavigationEntry, organizationCopy, type OrganizationOperations } from '../knowledge/route';
import { knowledgeViewports } from './knowledge-document-fixtures';
import { locales, type Locale } from '../paraglide/runtime.js';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const notebookId = id(1),
  structureRevisionId = id(4);
const source = {
  placementId: id(2),
  documentId: id(3),
  parentPlacementId: null,
  title: 'Character studies: a turning point',
  position: '2',
};
const destination = {
  ...source,
  placementId: id(6),
  documentId: id(7),
  title: 'Scene notes and narrative structure',
  position: '9',
};
type Scenario = 'review' | 'moved' | 'conflict' | 'historical' | 'unavailable';

/** Illustrative owner responses. Native and visual acceptance run independently after integration. */
function OrganizationExample({ scenario, locale = 'en' }: { scenario: Scenario; locale?: Locale }) {
  const router = useMemo(() => {
    const operations: OrganizationOperations = {
      read: async (request) => {
        if (scenario === 'unavailable') return { state: 'unavailable' };
        if (request.kind === 'history')
          return {
            state: 'ready',
            page: {
              kind: 'history',
              notebookId,
              revisions: [
                {
                  structureRevisionId: id(40),
                  revisionNumber: '4',
                  historyAvailable: true,
                  changeKind: 'placement_moved',
                  createdAt: '2026-11-11T12:00:00Z',
                  changes: [
                    {
                      placementId: source.placementId,
                      action: 'placement_moved',
                      previousParentPlacementId: null,
                      previousPosition: '2',
                      parentPlacementId: destination.placementId,
                      position: '5',
                    },
                  ],
                },
                {
                  structureRevisionId: id(41),
                  revisionNumber: '1',
                  historyAvailable: false,
                  changeKind: 'legacy',
                  createdAt: '2026-11-10T12:00:00Z',
                  changes: [],
                },
              ],
              next: null,
            },
          };
        return {
          state: 'ready',
          page: {
            kind: request.kind,
            notebookId,
            structureRevisionId: request.kind === 'historical' ? request.revisionId : structureRevisionId,
            parentPlacementId: request.parentPlacementId,
            placements: request.parentPlacementId ? [] : [source, destination],
            next: null,
          },
        };
      },
      prepare: async () => ({
        state: 'ready',
        binding: { viewer: id(99), csrfToken: 'illustrative-csrf', credential: 'illustrative-session-credential' },
      }),
      move: async () =>
        scenario === 'conflict'
          ? { state: 'conflict' }
          : {
              state: 'acknowledged',
              receipt: { notebookId, placementId: source.placementId, structureRevisionId: id(5) },
            },
    };
    const root = createRootRoute({
      component: () => (
        <KnowledgeNavigationEntry
          address={{ kind: 'outline', notebookId, parentPlacementId: null }}
          locale={locale}
          access="available"
          binding={`illustrative-owner-${locale}`}
          operations={{ read: async () => ({ state: 'retired' }), organization: operations }}
        />
      ),
    });
    const route = createRoute({ getParentRoute: () => root, path: '/knowledge' });
    return createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ['/knowledge'] }),
    });
  }, [scenario, locale]);
  return <RouterProvider router={router} />;
}
const meta = {
  title: 'Pages/Knowledge/Organization',
  component: OrganizationExample,
  args: { scenario: 'review', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { control: 'select', options: locales } },
  parameters: {
    layout: 'fullscreen',
    visitor: 'Signed In',
    viewport: { options: knowledgeViewports },
    docs: {
      description: {
        component:
          'Illustrative owner organization states. Review phone390 and desktop1280 in light and dark themes and all eight locales. Supplied document titles stay in their original language. Source typing does not establish native, mounted keyboard, visual or promotion proof.',
      },
    },
  },
} satisfies Meta<typeof OrganizationExample>;
export default meta;
type Story = StoryObj<typeof meta>;
const review: NonNullable<Story['play']> = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement),
    copy = organizationCopy(args.locale!);
  await userEvent.click(await canvas.findByRole('button', { name: `${copy.choose}: ${source.title}` }));
  await userEvent.click(canvas.getByRole('button', { name: `${copy.before}: ${destination.title}` }));
  await expect(await canvas.findByRole('button', { name: copy.confirm })).toBeEnabled();
};
export const MoveReview: Story = { args: { scenario: 'review' }, play: review };
export const Moved: Story = {
  args: { scenario: 'moved' },
  play: async (context) => {
    await review(context);
    const canvas = within(context.canvasElement),
      copy = organizationCopy(context.args.locale!);
    await userEvent.click(canvas.getByRole('button', { name: copy.confirm }));
    await expect(await canvas.findByRole('heading', { name: copy.moved })).toBeVisible();
    await expect(canvas.getByRole('button', { name: copy.parent })).toBeEnabled();
  },
};
export const StructureChanged: Story = {
  args: { scenario: 'conflict' },
  play: async (context) => {
    await review(context);
    const canvas = within(context.canvasElement),
      copy = organizationCopy(context.args.locale!);
    await userEvent.click(canvas.getByRole('button', { name: copy.confirm }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(copy.changed);
    await expect(canvas.getByRole('button', { name: copy.reselect })).toBeEnabled();
  },
};
export const HistoricalOutline: Story = {
  args: { scenario: 'historical' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement),
      copy = organizationCopy(args.locale!);
    await userEvent.click(await canvas.findByRole('button', { name: copy.history }));
    await expect(await canvas.findByText(copy.history_unavailable)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: `${copy.historical}: 4` }));
    await expect(await canvas.findByRole('heading', { name: copy.historical })).toBeVisible();
    await expect(canvas.getByRole('button', { name: copy.current })).toBeEnabled();
  },
};
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
