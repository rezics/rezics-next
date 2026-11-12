import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useMemo } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { KnowledgeNavigationEntry, type KnowledgeNavigationOperations } from '../knowledge/navigation-page';
import type { KnowledgeNavigationAddress, KnowledgeNavigationResult } from '../knowledge/navigation-read';
import { knowledgeViewports } from './knowledge-document-fixtures';
import { locales, type Locale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const placementId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const documentId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const structureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000030';
type Scenario = 'owned' | 'outline' | 'sparse' | 'changed' | 'unavailable';

/** Constructed signed-in examples, not native response recordings or admission evidence. */
function NavigationExample({ scenario, locale = 'en' }: { scenario: Scenario; locale?: Locale }) {
  const router = useMemo(() => {
    const address: KnowledgeNavigationAddress =
      scenario === 'owned' ? { kind: 'owned' } : { kind: 'outline', notebookId, parentPlacementId: null };
    const operations: KnowledgeNavigationOperations = {
      read: async (request): Promise<KnowledgeNavigationResult> => {
        if (scenario === 'changed') return { state: 'changed' };
        if (scenario === 'unavailable') return { state: 'unavailable' };
        if (request.kind === 'owned')
          return {
            state: 'ready',
            page: {
              kind: 'owned',
              next: null,
              notebooks: [
                {
                  notebookId,
                  subjectId: documentId,
                  structureRevisionId,
                  title: 'Character studies and narrative structure',
                  createdAt: '2026-11-10T10:00:00Z',
                },
                {
                  notebookId: structureRevisionId,
                  subjectId: documentId,
                  structureRevisionId,
                  title: 'Learning notes: assumptions, definitions and proofs',
                  createdAt: '2026-11-11T10:00:00Z',
                },
              ],
            },
          };
        return {
          state: 'ready',
          page: {
            kind: 'outline',
            notebookId,
            parentPlacementId: request.parentPlacementId,
            structureRevisionId,
            placements:
              scenario === 'sparse' || request.parentPlacementId
                ? []
                : [
                    {
                      placementId,
                      documentId,
                      parentPlacementId: null,
                      position: '3',
                      title: 'Inspiration: how a character changes through the story',
                    },
                    {
                      placementId: structureRevisionId,
                      documentId,
                      parentPlacementId: null,
                      position: '9',
                      title:
                        'Scene notes with a long supplied title that wraps on a narrow phone while both actions remain usable',
                    },
                  ],
            next: scenario === 'sparse' && !request.cursor ? 'illustrative-opaque-frontier' : null,
          },
        };
      },
    };
    const root = createRootRoute({
      component: () => (
        <KnowledgeNavigationEntry
          address={address}
          locale={locale}
          access="available"
          binding={`illustrative-signed-in-${locale}`}
          operations={operations}
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
  title: 'Pages/Knowledge/Navigation',
  component: NavigationExample,
  args: { scenario: 'owned', locale: 'en' },
  argTypes: { scenario: { control: false }, locale: { control: 'select', options: locales } },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: knowledgeViewports },
    visitor: 'Signed In',
    docs: {
      description: {
        component:
          'Illustrative signed-in inventory and outline pages. Review phone390 and desktop1280, light and dark themes, and all eight locales. Fixture titles are supplied English content. Native admission, browser and visual proof remain in the existing seeded integration lane.',
      },
    },
  },
} satisfies Meta<typeof NavigationExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Owned: Story = {
  args: { scenario: 'owned' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale as never };
    await expect(
      await canvas.findByRole('heading', { name: 'Character studies and narrative structure' }),
    ).toBeVisible();
    await expect(
      canvas.getAllByRole('link', {
        name: (name) => name.startsWith(m.knowledge_navigation_open_notebook({}, options)),
      }),
    ).toHaveLength(2);
  },
};
export const Outline: Story = {
  args: { scenario: 'outline' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale as never };
    await expect(
      await canvas.findByRole('link', {
        name: (name) => name.startsWith(m.knowledge_navigation_open_document({}, options) + ': Inspiration'),
      }),
    ).toHaveAttribute('href', `/knowledge/notebooks/${notebookId}/documents/${documentId}`);
    const explore = canvas.getAllByRole('button', {
      name: (name) => name.startsWith(m.knowledge_navigation_children({}, options)),
    })[0]!;
    await userEvent.click(explore);
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      m.knowledge_navigation_empty_outline({}, options),
    );
  },
};
export const Sparse: Story = {
  args: { scenario: 'sparse' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale as never };
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.knowledge_navigation_sparse({}, options));
    await userEvent.click(canvas.getByRole('button', { name: m.knowledge_navigation_more({}, options) }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      m.knowledge_navigation_empty_outline({}, options),
    );
  },
};
export const ChangedReading: Story = {
  args: { scenario: 'changed' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale as never };
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_navigation_changed({}, options));
    await expect(canvas.getByRole('button', { name: m.knowledge_navigation_restart({}, options) })).toBeEnabled();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const options = { locale: args.locale as never };
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.knowledge_navigation_unavailable({}, options));
    await expect(canvas.getByRole('button', { name: m.knowledge_navigation_retry({}, options) })).toBeEnabled();
  },
};
