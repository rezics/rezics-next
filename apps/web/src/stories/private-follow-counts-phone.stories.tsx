import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { PrivateFollowCountsPage } from '../library/private-follow-counts-page';
import { readFollowCounts, type FollowCountsReader } from '../library/private-follow-counts';
import { setLibraryFollowingStoryMode } from '../kernel/fake/library-following-story';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { PageStory, PatternStory } from './page';

// UNRUN authored plays. Route stories retain the existing recording bridge's missing-count responses.
// Loaded counts use a local native-shaped transport, not recorded or native authorization evidence.
const target = { targetType: 'collection' as const, targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000021' };
const path = `/library/follow-counts?targetType=collection&targetId=${target.targetId}`;
const routeRequests: Request[] = [];
let holdRoute = false;
const routeReleases: (() => void)[] = [];
let mountedJourney: ReturnType<typeof createJourney> | undefined;

const meta = {
  title: 'Pages/Library/Private follow counts',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Authored coverage, UNRUN. Connected routes exercise the actual back, Following and reload controls with the existing recording/admission bridge; no private count recording exists, so those reads honestly remain unavailable/denied. The local mounted pattern supplies safe-integer counts and HTTP recovery outcomes through the real reader and current-admission container. Its 320px inset and existing translated catalogue messages cover wrapping only. Reuse the global phone390/desktop1280 viewports and locale toolbar. Browser, native and full acceptance proof remain deferred.',
      },
    },
  },
  beforeEach: () => {
    routeRequests.length = 0;
    holdRoute = false;
    setLibraryFollowingStoryMode('recorded');
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(
        input instanceof Request ? input : new URL(String(input), window.location.href),
        init,
      );
      const url = new URL(request.url);
      if (url.origin === 'http://kernel.local' && url.pathname.startsWith('/v1/followCounts/')) {
        routeRequests.push(request);
        if (holdRoute) await new Promise<void>((resolve) => routeReleases.push(resolve));
      }
      return original(request);
    }) as typeof fetch;
    return () => {
      routeReleases.splice(0).forEach((release) => release());
      globalThis.fetch = original;
    };
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function countArticle(canvasElement: HTMLElement) {
  return within(canvasElement).getByRole('article');
}

async function physicalControls(article: HTMLElement) {
  const controls = [...article.querySelectorAll<HTMLElement>('a, button')];
  const bounds = article.getBoundingClientRect();
  const rects = controls.map((control) => {
    const rect = control.getBoundingClientRect();
    expect(rect.height).toBeGreaterThanOrEqual(44);
    expect(rect.width).toBeGreaterThanOrEqual(44);
    expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
    expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(getComputedStyle(control).whiteSpace).toBe('normal');
    expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth + 1);
    return rect;
  });
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      const first = rects[a]!;
      const second = rects[b]!;
      const overlap =
        Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 &&
        Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1;
      expect(overlap).toBe(false);
    }
  }
  for (const control of controls) {
    if (control.matches(':disabled')) continue;
    control.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    await expect(control).toHaveFocus();
    await waitFor(() => {
      const style = getComputedStyle(control);
      expect(style.outlineStyle).toBe('solid');
      expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
      expect(style.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
    });
  }
  for (const text of article.querySelectorAll<HTMLElement>('p, h1, h2')) {
    expect(getComputedStyle(text).overflowWrap).toBe('anywhere');
    expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1);
  }
  expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
  const document = article.ownerDocument.documentElement;
  expect(document.scrollWidth).toBeLessThanOrEqual(document.clientWidth + 1);
}

async function connectedRecovery(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { name: m.library_follow_counts_heading() });
  const article = countArticle(canvasElement);
  const view = within(article);
  const outgoing = within(view.getByRole('region', { name: m.library_follow_counts_outgoing() }));
  const contextual = within(view.getByRole('region', { name: m.library_follow_counts_target() }));
  await outgoing.findByText(m.library_follow_counts_unavailable());
  await contextual.findByText(m.library_follow_counts_denied());
  await waitFor(() => expect(routeRequests).toHaveLength(2));
  expect(article.querySelector('[data-follow-count]')).toBeNull();
  const back = view.getByRole('link', { name: m.nav_library() });
  const following = view.getByRole('link', { name: m.library_nav_following() });
  await expect(back).toHaveAttribute('href', `/${getLocale()}/library`);
  await expect(following).toHaveAttribute('href', `/${getLocale()}/library/following`);
  await physicalControls(article);
  expect(routeRequests).toHaveLength(2);
  holdRoute = true;
  const reload = view.getByRole('button', { name: m.library_follow_counts_reload() });
  reload.focus();
  await userEvent.keyboard('[Enter]');
  await waitFor(() => expect(reload).toBeDisabled());
  await waitFor(() => expect(routeRequests).toHaveLength(4));
  await expect(view.getByRole('region', { name: m.library_follow_counts_outgoing() })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(view.getByRole('region', { name: m.library_follow_counts_target() })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(article.querySelector('[data-follow-count]')).toBeNull();
  holdRoute = false;
  routeReleases.splice(0).forEach((release) => release());
  await outgoing.findByText(m.library_follow_counts_unavailable());
  await contextual.findByText(m.library_follow_counts_denied());
  await expect(reload).toBeEnabled();
  expect(routeRequests.map((request) => new URL(request.url).pathname)).toEqual([
    '/v1/followCounts/outgoing',
    `/v1/followCounts/collection/${target.targetId}`,
    '/v1/followCounts/outgoing',
    `/v1/followCounts/collection/${target.targetId}`,
  ]);
  expect(routeRequests.every((request) => request.method === 'GET' && new URL(request.url).search === '')).toBe(true);
  return { canvas, back, following };
}

export const RecoveryToFollowing: Story = {
  render: () => <PageStory visitor="Signed In" path={path} />,
  play: async ({ canvasElement }) => {
    const { canvas, following } = await connectedRecovery(canvasElement);
    await userEvent.click(following);
    await canvas.findByRole('heading', { name: m.library_following_heading() });
    await canvas.findByRole('link', { name: 'Kokoro' });
    expect(routeRequests).toHaveLength(4);
  },
};

export const BackToLibrary: Story = {
  render: () => <PageStory visitor="Signed In" path={path} />,
  play: async ({ canvasElement }) => {
    const { canvas, back } = await connectedRecovery(canvasElement);
    await userEvent.click(back);
    await canvas.findByRole('heading', { name: m.library_heading() });
    await canvas.findByRole('link', { name: getLocale() === 'zh-Hans' ? '心' : 'Kokoro' });
    expect(routeRequests).toHaveLength(4);
  },
};

function createJourney(client: QueryClient) {
  const viewer = { subject: 'count-story-viewer', csrfToken: 'count-story-session' };
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', ...viewer });
  const lifetime = viewerExposureLifetime(client);
  const releaseAdmission = lifetime.subscribe(() => {});
  const snapshot = lifetime.getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Expected current viewer observation');
  const admissionKey = viewerExposureQuery(snapshot.observation).queryKey;
  client.setQueryData(admissionKey, { subject: viewer.subject, admitted: ['personal_library'] });
  client.setQueryData(['exposure', 'anonymous'], []);
  const journey = {
    reads: 0,
    calls: [] as Request[],
    zero: false,
    held: false,
    releases: [] as (() => void)[],
    releaseAdmission,
    withdraw: () => client.setQueryData(admissionKey, { subject: viewer.subject, admitted: [] }),
    signOut: () => client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
  };
  const native = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      journey.calls.push(request);
      if (request.url.endsWith('/outgoing'))
        return Response.json({ followingCount: journey.zero ? 0 : Number.MAX_SAFE_INTEGER });
      return Response.json(
        { code: journey.zero ? 'not_found' : 'dependency_unavailable' },
        {
          status: journey.zero ? 404 : 503,
          headers: { 'retry-after': '7', 'cache-control': 'private, no-store' },
        },
      );
    }) as typeof fetch,
  });
  const read: FollowCountsReader = async ({ data }) => {
    journey.reads++;
    if (journey.held) await new Promise<void>((resolve) => journey.releases.push(resolve));
    return { viewer, locale: getLocale(), ...(await readFollowCounts(native, 'Bearer local-count-pattern', data)) };
  };
  return Object.assign(journey, { read });
}

function LocalCounts() {
  const client = useQueryClient();
  const [journey, setJourney] = useState<ReturnType<typeof createJourney>>();
  useEffect(() => {
    const prepared = createJourney(client);
    mountedJourney = prepared;
    setJourney(prepared);
    return () => {
      prepared.releases.splice(0).forEach((release) => release());
      prepared.releaseAdmission();
      if (mountedJourney === prepared) mountedJourney = undefined;
    };
  }, [client]);
  return journey ? <PrivateFollowCountsPage context={target} read={journey.read} /> : null;
}

function MountedCountsStory() {
  return (
    <PatternStory visitor="Signed In" path={path}>
      <div className="w-80 max-w-full">
        <LocalCounts />
      </div>
    </PatternStory>
  );
}

async function longCountReady(canvasElement: HTMLElement) {
  await waitFor(() => expect(mountedJourney).toBeDefined());
  const article = countArticle(canvasElement);
  await within(article).findByText(new Intl.NumberFormat(getLocale()).format(Number.MAX_SAFE_INTEGER));
  const targetRegion = within(article).getByRole('region', { name: m.library_follow_counts_target() });
  await within(targetRegion).findByText(m.library_follow_counts_retry_after({ value: '7' }));
  expect(targetRegion.querySelector('[data-follow-count]')).toBeNull();
  await physicalControls(article);
  expect(mountedJourney!.reads).toBe(1);
  expect(mountedJourney!.calls).toHaveLength(2);
  return { article, journey: mountedJourney! };
}

export const LongCountAndGuidance: Story = {
  globals: { locale: 'de' },
  render: () => <MountedCountsStory />,
  play: async ({ canvasElement }) => {
    await longCountReady(canvasElement);
  },
};

export const IndependentRecoveryAndWithdrawal: Story = {
  render: () => <MountedCountsStory />,
  play: async ({ canvasElement }) => {
    const { article, journey } = await longCountReady(canvasElement);
    const view = within(article);
    journey.zero = true;
    journey.held = true;
    const reload = view.getByRole('button', { name: m.library_follow_counts_reload() });
    await userEvent.click(reload);
    await waitFor(() => expect(reload).toBeDisabled());
    expect(article.querySelector('[data-follow-count]')).toBeNull();
    journey.held = false;
    journey.releases.splice(0).forEach((release) => release());
    await view.findByText('0', { exact: true });
    await view.findByText(m.library_follow_counts_denied());
    expect(journey.reads).toBe(2);
    expect(journey.calls).toHaveLength(4);
    journey.withdraw();
    await waitFor(() => expect(article.querySelector('[data-follow-count]')).toBeNull());
    await waitFor(() => expect(view.queryByRole('button')).toBeNull());
    expect(view.getAllByText(m.platform_closed_heading())).toHaveLength(2);
    expect(view.queryByRole('link', { name: m.account_sign_in() })).toBeNull();
    await physicalControls(article);
    journey.signOut();
    await waitFor(() => expect(view.getAllByRole('link', { name: m.account_sign_in() })).toHaveLength(2));
    const signIns = view.getAllByRole('link', { name: m.account_sign_in() });
    const returnTo = `/${getLocale()}${path}`;
    for (const link of signIns)
      await expect(link).toHaveAttribute('href', `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
    expect(signIns.map((link) => link.getAttribute('aria-describedby'))).toEqual([
      'outgoing-count-heading',
      'target-count-heading',
    ]);
    await physicalControls(article);
    expect(journey.reads).toBe(2);
    expect(journey.calls).toHaveLength(4);
  },
};
