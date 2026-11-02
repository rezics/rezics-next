import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQuery } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { expect, fn, userEvent, within } from 'storybook/test';
import { loadBoardPageWithAuthors } from '../identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../kernel/fake';
import { image, bannerImage } from '../kernel/fake/community';
import board from '../kernel/recorded/board.json';
import realmBoard from '../kernel/recorded/board-realm.json';
import realm from '../kernel/recorded/board-realm-realm.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { BoardCommunity, BoardCommunityStatus } from '../threads/board-community';
import type { CommunityPresentation } from '../threads/board-community-source';
import { PatternStory } from './page';

const description = `${'A reading room for careful discussion, rereading, and different interpretations. '.repeat(12)}\n${'LongCommunityDescription'.repeat(16)}\nThe complete description ends here.`;
const rulesText = `${'Discuss the work with care and mark spoilers before sharing them. '.repeat(24)}\n${'LongSuppliedRule'.repeat(20)}\nThe final supplied rule remains readable.`;
const retry = fn();
type State = 'multiple' | 'none' | 'unavailable' | 'source-unavailable' | 'global';

// Explicit presentation-contract responses use the real loader and existing derivative assets.
// They establish consumer coverage only; no native availability or membership is inferred.
async function loadExample(state: State) {
  const body = fromPlainText(rulesText);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeDocument(body)));
  const community: CommunityPresentation = {
    realmId: realm.realm.realmId,
    spaceId: realm.realm.spaceId,
    contextId: realm.realm.contextId,
    name: realm.realm.title,
    description: state === 'none' ? '' : description,
    avatar:
      state === 'none'
        ? { state: 'none', value: null }
        : {
            state: 'available',
            value: {
              ...image,
              containerId: realm.realm.realmId,
              credit: {
                rightsHolder: 'Avatar illustrator',
                via: { name: 'Avatar source', url: 'https://example.org/avatar' },
                license: 'CC-BY-4.0',
                obligations: ['cc:Attribution'],
              },
            },
          },
    banner:
      state === 'none'
        ? { state: 'unavailable', value: null }
        : {
            state: 'available',
            value: {
              ...bannerImage,
              containerId: realm.realm.realmId,
              credit: {
                rightsHolder: 'Banner photographer',
                via: { name: 'Banner source', url: 'https://example.org/banner' },
                license: 'CC-BY-SA-4.0',
                obligations: ['cc:Attribution', 'cc:ShareAlike'],
              },
            },
          },
    members:
      state === 'none'
        ? { state: 'unknown', count: null, version: null }
        : { state: 'current', count: 128, version: 'supplied-count' },
    rules:
      state === 'none' || state === 'unavailable'
        ? { state, value: null }
        : {
            state: 'available',
            value: {
              postId: '01a17ce8-2850-71fd-a965-456700000001',
              revisionId: '01a17ce8-2850-71fe-874d-456700000002',
              body,
              licence: 'MIT',
              sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
            },
          },
    join: { membership: 'unknown', action: null },
  };
  const recorded = createStoryRecordedKernelFetch();
  return loadBoardPageWithAuthors(
    createKernelClient('https://kernel.story', {
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): ReturnType<typeof fetch> => {
          const path = new URL(new Request(input, init).url).pathname;
          if (state !== 'global' && path === `/v1/boards/${realmBoard.board.id}`) {
            return Response.json({
              board: {
                ...realmBoard.board,
                ...(state === 'source-unavailable' ? {} : { community }),
              },
            });
          }
          if (state === 'source-unavailable' && path.startsWith('/v1/realms/'))
            return Response.json({ code: 'not_found' }, { status: 404 });
          return recorded(input, init);
        },
        { preconnect: recorded.preconnect },
      ),
    }),
    { id: state === 'global' ? board.board.id : realmBoard.board.id },
  );
}

function AboutExample({ state }: { state: State }) {
  const query = useQuery({ queryKey: ['board-about-family', state], queryFn: () => loadExample(state) });
  if (query.isPending) return <BoardCommunityStatus state="loading" />;
  if (query.isError) return <BoardCommunityStatus state="error" onRetry={() => void query.refetch()} />;
  return (
    <div className="mx-auto max-w-6xl space-y-10 p-4">
      <BoardCommunity page={query.data} sort="active" />
      {state === 'multiple' ? (
        <BoardCommunity page={{ ...query.data, board: { ...query.data.board, visibility: 'protected' } }} sort="hot" />
      ) : null}
    </div>
  );
}

const meta = {
  title: 'Patterns/Community/Board About Family',
  component: BoardCommunity,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Supplied About and rules stay in ordinary flow below the existing hero. Plays are authored for phone390 and desktop1280, light/dark and locale globals; native and visual evidence remain integration obligations.',
      },
    },
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof BoardCommunity>;
export default meta;
type Story = StoryObj;
const example = (state: State) => (
  <PatternStory>
    <AboutExample state={state} />
  </PatternStory>
);

export const MultipleBoards: Story = {
  render: () => example('multiple'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const asides = await view.findAllByRole('complementary', { name: m.board_community_about() });
    await expect(asides).toHaveLength(2);
    const identities: string[] = [];
    for (const aside of asides) {
      const about = within(aside);
      const heading = about.getByRole('heading', { level: 2, name: m.board_community_about() });
      const rules = about.getByRole('region', { name: m.board_community_rules() });
      const rulesHeading = within(rules).getByRole('heading', { level: 3, name: m.board_community_rules() });
      await expect(aside).toHaveAttribute('aria-labelledby', heading.id);
      await expect(rules).toHaveAttribute('aria-labelledby', rulesHeading.id);
      for (const element of [heading, rulesHeading]) {
        await expect(canvasElement.ownerDocument.getElementById(element.id)).toBe(element);
        identities.push(element.id);
      }
      await expect(
        about.getByText((_text, element) => element?.tagName === 'P' && element.textContent === description),
      ).toBeVisible();
      await expect(rules).toHaveTextContent('The final supplied rule remains readable.');
      for (const paragraph of rulesText.split('\n')) await expect(rules.textContent).toContain(paragraph);
      await expect(about.getByRole('link', { name: realm.realm.title })).toHaveAttribute(
        'href',
        `/${getLocale()}/realms/${realm.realm.realmId}`,
      );
      await expect(about.getByRole('link', { name: m.board_community_rules_revision() })).toHaveAttribute(
        'href',
        `/${getLocale()}/posts/01a17ce8-2850-71fd-a965-456700000001/revisions/01a17ce8-2850-71fe-874d-456700000002`,
      );
      await expect(about.getByText('MIT')).toBeVisible();
      for (const credit of ['Avatar illustrator', 'CC-BY-4.0', 'Banner photographer', 'CC-BY-SA-4.0'])
        await expect(aside.textContent).toContain(credit);
      for (const [name, href] of [
        ['Avatar source', 'https://example.org/avatar'],
        ['Banner source', 'https://example.org/banner'],
      ] as const)
        await expect(about.getByRole('link', { name })).toHaveAttribute('href', href);
      await expect(aside.querySelector('details')).toBeNull();
      await expect(aside.scrollWidth).toBeLessThanOrEqual(aside.clientWidth);
    }
    await expect(new Set(identities).size).toBe(4);
    await expect(view.getAllByText(m.board_community_members({ count: 128 }))).toHaveLength(2);
    await expect(view.queryByText(m.board_community_members_unknown())).toBeNull();
    await expect(view.getByText(m.board_community_protected_help())).toBeVisible();
    for (const trigger of view.getAllByRole('button', { name: m.board_more_actions() })) {
      await expect(trigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(trigger.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    }
  },
};

export const NoRules: Story = {
  render: () => example('none'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.board_community_rules_none())).toBeVisible();
    await expect(view.getByText(m.board_community_members_unknown())).toBeVisible();
    await expect(view.queryByText(realm.realm.summary)).toBeNull();
    await expect(view.queryByRole('link', { name: m.board_community_rules_revision() })).toBeNull();
    await expect(view.queryByRole('link', { name: 'Avatar source' })).toBeNull();
    await expect(view.queryByRole('link', { name: 'Banner source' })).toBeNull();
  },
};
export const UnavailableRules: Story = {
  render: () => example('unavailable'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.board_community_rules_unavailable())).toBeVisible();
    await expect(view.queryByText(m.board_community_rules_none())).toBeNull();
    await expect(view.queryByRole('link', { name: m.board_community_rules_revision() })).toBeNull();
  },
};
export const SourceUnavailable: Story = {
  render: () => example('source-unavailable'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.board_community_source_unavailable())).toBeVisible();
    await expect(view.getByText(m.board_community_rules_unavailable())).toBeVisible();
    await expect(view.queryByText(m.board_community_global())).toBeNull();
    await expect(view.queryByRole('link', { name: realm.realm.title })).toBeNull();
    await expect(view.queryByRole('button', { name: m.realm_join() })).toBeNull();
  },
};
export const Global: Story = {
  render: () => example('global'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.board_community_global())).toBeVisible();
    await expect(view.queryByRole('heading', { name: m.board_community_rules() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.realm_join() })).toBeNull();
  },
};

function observeStatus(state: 'loading' | 'error' | 'closed') {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(
      state === 'loading'
        ? m.board_community_loading()
        : state === 'error'
          ? m.error_message()
          : m.platform_closed_message(),
    );
    await expect(view.queryByText(m.board_threads_empty())).toBeNull();
    await expect(view.queryByRole('complementary')).toBeNull();
    if (state === 'error') {
      const button = view.getByRole('button', { name: m.board_community_retry() });
      await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      await userEvent.click(button);
      await expect(retry).toHaveBeenCalledTimes(1);
    }
  };
}
export const Loading: Story = {
  render: () => <BoardCommunityStatus state="loading" />,
  play: observeStatus('loading'),
};
export const Error: Story = {
  beforeEach: () => {
    retry.mockClear();
  },
  render: () => <BoardCommunityStatus state="error" onRetry={retry} />,
  play: observeStatus('error'),
};
export const Closed: Story = { render: () => <BoardCommunityStatus state="closed" />, play: observeStatus('closed') };
