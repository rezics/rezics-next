import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { memoryReaderActions } from '../catalogue/fixtures.ts';
import { fixtureFollow, memoryRelationships } from '../relationships/fixtures.ts';
import { relationshipStoryFetch } from '../relationships/story-fetch.ts';
import { FeedProvider } from './feed-context.tsx';
import { FeedList } from './feed-list.tsx';
import { memoryFeed, NOW, page, post, realms, storyId } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import type { FeedPage, FeedQuery } from './types.ts';

const query = { scope: 'following', sort: 'new' } satisfies FeedQuery;
const caughtUp = {
  asOf: new Date(NOW).toISOString(),
  lastVisitedAt: null,
  state: 'caught-up' as const,
};
const partial = (items: FeedPage['items'], nextCursor: string | null = null): FeedPage => ({
  ...page(items, { sort: 'new', nextCursor }),
  projection: { sequence: '39', reviewSequence: '7', status: 'catching-up' },
});

function scenario(initial: FeedPage, recover = false, newerCut = false) {
  let ready = false;
  const api = memoryFeed();
  api.page = async (input) => {
    api.calls.push(`page:${input.cursor ?? ''}`);
    if (input.cursor === 'old-2') return { ok: true, data: partial([post(11), post(13)]) };
    if (!ready) return { ok: true, data: initial };
    if (newerCut)
      return {
        ok: true,
        data: { ...page([post(99)]), sourcePosition: { dataEpoch: 'story', sequence: '41' } },
      };
    if (!recover) return { ok: true, data: page([post(1)], { caughtUp }) };
    const groups: Record<string, number[]> = {
      '': [1, 2, 3],
      r2: [4, 5, 6],
      r3: [7, 8, 9],
      r4: [10, 11, 12, 13],
      r5: [14, 15],
    };
    const next: Record<string, string> = { '': 'r2', r2: 'r3', r3: 'r4', r4: 'r5' };
    const cursor = input.cursor ?? '';
    return {
      ok: true,
      data: page(
        (groups[cursor] ?? []).map((n) => post(n)),
        {
          nextCursor: next[cursor] ?? null,
          caughtUp: next[cursor] ? { ...caughtUp, state: 'more' } : caughtUp,
        },
      ),
    };
  };
  return {
    api,
    finish() {
      ready = true;
    },
  };
}

interface Args {
  initial: FeedPage;
  locale: 'en' | 'zh-Hans';
  scenario: ReturnType<typeof scenario>;
  query?: FeedQuery;
}

function ProjectionFeed({ initial, locale, scenario: fixture, query: input = query }: Args) {
  return (
    <FeedProvider
      locale={locale}
      messages={locale === 'zh-Hans' ? { ...messages, ...zhHans } : messages}
      now={NOW}
      signedIn
      actingSubject={storyId(801, 'bbbb')}
      signInHref="/auth/start"
      avatarQuery=""
      tab="following"
      followedRealms={[realms.fiction.id]}
      api={fixture.api}
    >
      <ReaderActionsProvider signedIn signInHref="/auth/start" actions={memoryReaderActions({})}>
        <div className="mx-auto max-w-[46rem] py-6 sm:px-6">
          <FeedList
            initial={{ ok: true, data: initial }}
            query={input}
            allHref={`/${locale}?tab=all`}
            headInterval={100}
            empty={
              <p className="px-4 py-10 text-center text-muted-foreground text-sm">
                {locale === 'en' ? messages.emptyFollowing : zhHans.emptyFollowing}
              </p>
            }
          />
        </div>
      </ReaderActionsProvider>
    </FeedProvider>
  );
}

const meta = {
  title: 'Feed/Projection recovery',
  component: ProjectionFeed,
  args: { locale: 'en' },
  beforeEach() {
    const original = window.fetch;
    window.fetch = relationshipStoryFetch(
      memoryRelationships([
        { ...fixtureFollow(1, 'realm'), id: realms.fiction.id, realm: realms.fiction.id },
      ]).api,
      original,
    );
    return () => {
      window.fetch = original;
      window.scrollTo(0, 0);
    };
  },
} satisfies Meta<typeof ProjectionFeed>;
export default meta;
type Story = StoryObj<typeof meta>;

async function capture(name: string) {
  if (!('__vitest_browser__' in globalThis)) return;
  const { page } = await import('vitest/browser');
  await page.viewport(name.endsWith('zh-Hans') ? 390 : 1280, 860);
  await document.fonts.ready;
  const options = { path: `../../../../.temp/g-1047/${name}.png`, target: 'page' as const };
  await page.screenshot(options);
}

const arriving = (locale: Args['locale']) =>
  locale === 'en' ? messages.arriving : zhHans.arriving;
const empty = (locale: Args['locale']) =>
  locale === 'en' ? messages.emptyFollowing : zhHans.emptyFollowing;

function emptyStory(locale: Args['locale'], building: boolean): Story {
  const initial = building ? partial([]) : page([]);
  return {
    args: { locale, initial, scenario: scenario(initial) },
    globals: { locale },
    async play({ canvasElement, args }) {
      const canvas = within(canvasElement);
      if (building) {
        await expect(canvas.getByRole('status')).toHaveTextContent(arriving(locale));
        await expect(canvas.queryByText(empty(locale))).toBeNull();
        await waitFor(() => expect(args.scenario.api.calls).toContain('page:'));
        await expect(
          args.scenario.api.calls.filter((call) => call.startsWith('watermark')),
        ).toEqual([]);
      } else {
        await expect(canvas.getByText(empty(locale))).toBeVisible();
        await expect(canvas.queryByRole('status')).toBeNull();
      }
      await capture(`empty-${building ? 'building' : 'ready'}-${locale}`);
    },
  };
}

export const EmptyReady: Story = emptyStory('en', false);
export const EmptyReadyChinese: Story = emptyStory('zh-Hans', false);
export const EmptyBuilding: Story = emptyStory('en', true);
export const EmptyBuildingChinese: Story = emptyStory('zh-Hans', true);

function buildingStory(locale: Args['locale']): Story {
  const initial = partial([post(1), post(3)]);
  return {
    args: { locale, initial, scenario: scenario(initial), query: { scope: 'all', sort: 'top' } },
    globals: { locale },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      await expect(canvas.getAllByRole('article')).toHaveLength(2);
      await expect(canvas.getByText(arriving(locale)).closest('[role="status"]')).toBeVisible();
      await expect(canvas.getAllByRole('article')[0]).toHaveAttribute('aria-setsize', '-1');
      await capture(`populated-building-${locale}`);
    },
  };
}
export const RankedBuilding: Story = buildingStory('en');
export const RankedBuildingChinese: Story = buildingStory('zh-Hans');

function readyStory(locale: Args['locale']): Story {
  const initial = page([post(1), post(3)], { caughtUp });
  return {
    args: { locale, initial, scenario: scenario(initial) },
    globals: { locale },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      await expect(
        canvas.getByRole('region', { name: locale === 'en' ? messages.caughtUp : zhHans.caughtUp }),
      ).toBeVisible();
      await expect(canvas.queryByText(arriving(locale))).toBeNull();
      await capture(`following-ready-${locale}`);
    },
  };
}
export const FollowingReady: Story = readyStory('en');
export const FollowingReadyChinese: Story = readyStory('zh-Hans');

function emptyRecoveryStory(locale: Args['locale']): Story {
  const initial = partial([]);
  return {
    args: { locale, initial, scenario: scenario(initial) },
    globals: { locale },
    async play({ canvasElement, args }) {
      const canvas = within(canvasElement);
      await expect(canvas.getByRole('status')).toHaveTextContent(arriving(locale));
      args.scenario.finish();
      await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(1));
      await expect(
        canvas.getByRole('region', { name: locale === 'en' ? messages.caughtUp : zhHans.caughtUp }),
      ).toBeVisible();
      await waitFor(() => expect(args.scenario.api.calls).toContain('watermark:following'));
      await capture(`empty-recovered-${locale}`);
    },
  };
}
export const EmptyRecovers: Story = emptyRecoveryStory('en');
export const EmptyRecoversChinese: Story = emptyRecoveryStory('zh-Hans');

function recoveryStory(locale: Args['locale']): Story {
  const initial = partial(
    [1, 3, 5, 7, 9].map((n) => post(n)),
    'old-2',
  );
  return {
    args: { locale, initial, scenario: scenario(initial, true) },
    globals: { locale },
    async play({ canvasElement, args }) {
      const canvas = within(canvasElement);
      // Read the old second page before the index is ready.
      window.scrollTo(0, document.documentElement.scrollHeight);
      await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(7));
      const anchor = canvasElement.querySelector<HTMLElement>(`[data-feed-item="${post(5).id}"]`)!;
      window.scrollTo(0, window.scrollY + anchor.getBoundingClientRect().top + 48);
      const top = anchor.getBoundingClientRect().top;
      args.scenario.finish();
      await waitFor(() => expect(canvas.getAllByRole('article')).toHaveLength(13));
      await expect(canvas.queryByText(arriving(locale))).toBeNull();
      await expect(
        canvas
          .getAllByRole('article')
          .map((row) => row.closest<HTMLElement>('[data-feed-item]')!.dataset.feedItem),
      ).toEqual(Array.from({ length: 13 }, (_, i) => post(i + 1).id));
      await expect(Math.abs(anchor.getBoundingClientRect().top - top)).toBeLessThan(2);
      await expect(args.scenario.api.calls.filter((call) => call.startsWith('page:r'))).toEqual([
        'page:r2',
        'page:r3',
        'page:r4',
      ]);
      await capture(`reading-place-recovered-${locale}`);
    },
  };
}
export const KeepsReadingPlace: Story = recoveryStory('en');
export const KeepsReadingPlaceChinese: Story = recoveryStory('zh-Hans');

function newerStory(locale: Args['locale']): Story {
  const initial = partial([post(1), post(3)]);
  return {
    args: { locale, initial, scenario: scenario(initial, false, true) },
    globals: { locale },
    async play({ canvasElement, args }) {
      const canvas = within(canvasElement);
      args.scenario.finish();
      await expect(await canvas.findByRole('alert')).toHaveTextContent(
        locale === 'en' ? messages.moved : zhHans.moved,
      );
      await expect(canvas.getAllByRole('article')).toHaveLength(2);
      await expect(canvas.queryByRole('article', { name: 'Work 99' })).toBeNull();
      await expect(
        canvas.getByRole('button', { name: locale === 'en' ? messages.refresh : zhHans.refresh }),
      ).toBeVisible();
      await capture(`new-source-deferred-${locale}`);
    },
  };
}
export const DefersNewerSource: Story = newerStory('en');
export const DefersNewerSourceChinese: Story = newerStory('zh-Hans');
