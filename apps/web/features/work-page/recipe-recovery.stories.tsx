import { useEffect, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import { browserMainApi } from '../api/browser.ts';
import { seedTypes } from '../catalogue/types.ts';
import { workExperience } from '../entity-page/experience.ts';
import { instructionVisitIdentity, instructionVisitTransport } from '../recipe-editor/instruction-recorded-fixture.ts';
import { englishMessages } from './messages.ts';
import { recipePageReader } from './recipe-reading-recorded-page.ts';
import { recipeRegion, recipeWorkFrame, recipeWorkOverview } from './recipe-reading-recorded-page.tsx';
import { EVERYONE, workHref } from './route.ts';
import { WorkFrame } from './work-frame.tsx';
import { WorkKindActions } from './types/actions.tsx';

const recordingAsset = new URL('../../../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url);

/** The existing captured visit, with three supplemental reads held across a refresh.
 * Refresh composes the next owner snapshot; this does not simulate the RSC transport. */
function RecipeRecovery({ auxiliaries }: { auxiliaries?: 'pending' | 'unavailable' }) {
  const [snapshot, setSnapshot] = useState<{
    node: ReactNode; refresh: () => void; failedMethodReads: number; methodRequests: string[];
    supplementalRequests: { path: string; state: 'pending' | 'unavailable' }[];
    auxiliaries?: 'pending' | 'unavailable';
  } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let recovered = false;
    let failedMethodReads = 0;
    const methodRequests: string[] = [];
    const supplementalRequests: { path: string; state: 'pending' | 'unavailable' }[] = [];
    const gate = Promise.withResolvers<void>();
    const pending = new Set<Promise<Response>>();
    const note = (error: unknown) => { if (live) setFault(String(error)); };
    const visit = instructionVisitTransport(auxiliaries ? 'owner' : 'visitor', window.location.origin, async source => {
      if (source !== 'tests/fixtures/recipes/original-tomato-method.wav') throw new Error(`Unregistered asset ${source}`);
      const response = await fetch(recordingAsset);
      if (!response.ok) throw new Error('Recording fixture unavailable');
      return new Uint8Array(await response.arrayBuffer());
    }, note);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const read = (async () => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
        if (auxiliaries && (url.pathname.endsWith('/reader-state') || url.pathname.endsWith('/resources/showcase')
          || url.pathname.endsWith('/statements') || url.pathname.endsWith('/rating-contexts'))) {
          supplementalRequests.push({ path: url.pathname, state: auxiliaries });
          if (auxiliaries === 'pending') await gate.promise;
          else return Response.json({ code: 'specific_unavailable' }, { status: 503 });
        }
        if (url.pathname.endsWith('/agent-credits') || url.pathname.endsWith('/selection')
          || /\/agents\/[^/]+\/works$/.test(url.pathname)) {
          await gate.promise;
        }
        // A definitive section refusal exercises the existing RetryButton. The
        // healthy snapshot uses the unchanged captured method and exact identity.
        if (url.pathname.endsWith(`/recipes/works/${visit.id}`)) {
          methodRequests.push(`${url.pathname}${url.search}`);
          if (!recovered) {
            failedMethodReads++;
            return Response.json({ code: 'unavailable' }, { status: 503 });
          }
        }
        return visit.fetcher(input, init);
      })();
      pending.add(read);
      try { return await read; } finally { pending.delete(read); }
    }) as typeof fetch;
    const main = browserMainApi(window.location.origin, { anonymous: visit.actingSubject === null, fetcher });
    const host = { ...visit.host, main,
      anonymous: browserMainApi(window.location.origin, { anonymous: true, fetcher }),
      publicFetch: fetcher, recordingFetch: fetcher,
      recipeReadPage: (href: string) => recipePageReader({ main, actingSubject: visit.actingSubject }, href) };
    const ready = (async () => {
      const types = await host.anonymous.v1.types.get();
      if (types.error || !types.data) throw new Error(`Type registry answered ${types.error?.status ?? 'nothing'}`);
      seedTypes(types.data);
    })();
    const compose = async () => {
      await ready;
      // The signed-in cases isolate the actual frame and method; overview's
      // separate progress workflow is outside this captured frame interaction.
      const overview = auxiliaries
        ? await recipeRegion({ host, id: visit.id, work: visit.header, href: `/v1/recipes/works/${visit.id}`,
          locale: 'en', messages: englishMessages })
        : await recipeWorkOverview({ host, id: visit.id, workRef: visit.id, work: visit.header,
          scope: EVERYONE, locale: 'en', messages: englishMessages });
      let node = await recipeWorkFrame({ host, id: visit.id, workRef: visit.id, work: visit.header,
        locale: 'en', messages: englishMessages, children: overview });
      // Finish counting the frame's own method read before publishing a snapshot.
      if (auxiliaries) await node.props.readAction.props.children;
      if (auxiliaries === 'unavailable') {
        // Storybook mounts a client tree, so completed server slots enter the
        // snapshot as their actual produced nodes. Credits, notes and author
        // reads stay held; the pending variant keeps its unresolved slots.
        const [shelfAction, ratingAction, evidence, identity] = await Promise.all([
          node.props.shelfAction.props.children, node.props.ratingAction.props.children,
          node.props.evidence.props.children, node.props.identity.props.children.props.children]);
        node = <WorkFrame {...node.props} shelfAction={shelfAction} ratingAction={ratingAction}
          evidence={evidence} identity={identity} />;
      }
      if (live) setSnapshot({ node, failedMethodReads, methodRequests: [...methodRequests],
        supplementalRequests: [...supplementalRequests], auxiliaries,
        refresh: () => { recovered = true; void compose().catch(note); } });
    };
    setSnapshot(null); setFault(null);
    void compose().catch(note);
    return () => {
      live = false;
      gate.resolve();
      // Released supplemental reads may start the captured author's next read.
      void (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
        visit.dispose();
      })();
    };
  }, [auxiliaries]);
  const identity = instructionVisitIdentity(auxiliaries ? 'owner' : 'visitor');
  if (fault) return <p role="alert" data-replay-miss>{fault}</p>;
  if (!snapshot) return <p role="status" aria-busy="true">{englishMessages.loading}</p>;
  const frame = <StoryRouteContext value={{ pathname: workHref(identity.id), search: 'language=en', onRefresh: snapshot.refresh }}>
    {snapshot.node}
  </StoryRouteContext>;
  return auxiliaries ? <div data-frame-method-failures={snapshot.failedMethodReads}
    data-frame-method-requests={JSON.stringify(snapshot.methodRequests)} data-frame-auxiliaries={snapshot.auxiliaries}
    data-frame-supplemental-requests={JSON.stringify(snapshot.supplementalRequests)}>{frame}</div> : frame;
}

const meta = {
  title: 'Work page/Recipe recovery', component: RecipeRecovery,
  globals: { locale: 'en', viewport: { value: 'desktop' } },
  parameters: { controls: { disable: true } },
} satisfies Meta<typeof RecipeRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;

async function failedSection(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const identity = instructionVisitIdentity('visitor');
  await canvas.findByRole('heading', { name: identity.header.title.value, level: 1 });
  const alert = await canvas.findByRole('alert');
  expect(alert).toHaveTextContent(englishMessages.recipeMethod);
  const retry = within(alert).getByRole('button', { name: englishMessages.retry });
  await expect(retry).toBeEnabled();
  await expect(canvas.getByRole('button', { name: englishMessages.cookThis })).toBeDisabled();
  expect(canvas.queryByText(englishMessages.recipeUnstructured)).toBeNull();
  expect(canvas.queryByText('Want to read')).toBeNull();
  expect(canvasElement.querySelector('[data-replay-miss]')).toBeNull();
  return retry;
}

export const UnavailableMethod: Story = { play: async ({ canvasElement }) => { await failedSection(canvasElement); } };

async function recover(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const retry = await failedSection(canvasElement);
  const title = canvas.getByRole('heading', { level: 1 });
  const shelf = canvas.getByRole('link', { name: new RegExp(`^${englishMessages.wantToCook}`) });
  await userEvent.click(retry);
  await canvas.findAllByText('Stir', { exact: false });
  await waitFor(() => expect(canvas.queryByRole('alert')).toBeNull());
  expect(canvas.getByRole('heading', { level: 1 })).toBe(title);
  expect(canvas.getByRole('link', { name: new RegExp(`^${englishMessages.wantToCook}`) })).toBe(shelf);
  const cook = canvas.getByRole('button', { name: englishMessages.cookThis });
  await expect(cook).toBeEnabled();
  await userEvent.click(cook);
  const dialog = await canvas.findByRole('dialog', { name: englishMessages.cookMode });
  expect(within(dialog).getAllByText('Stir', { exact: false }).length).toBeGreaterThan(0);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
  await expect(cook).toHaveFocus();
  expect(canvasElement.querySelector('[data-replay-miss]')).toBeNull();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
}

export const RecoveredMethod: Story = { play: async ({ canvasElement }) => { await recover(canvasElement); } };
export const RecoveredMethodPhone: Story = { globals: { viewport: { value: 'phone' } }, play: async ({ canvasElement }) => {
  await recover(canvasElement);
  canvasElement.querySelector('#recipe-experience')?.scrollIntoView();
} };

async function recoverFrameMethod(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const identity = instructionVisitIdentity('owner');
  await canvas.findByRole('heading', { name: identity.header.title.value, level: 1 });
  const subject = canvasElement.querySelector('[data-subject-header]')!;
  expect(subject).toHaveAttribute('data-resource', identity.header.id);
  expect(subject).toHaveAttribute('data-semantic-type', 'https://schema.org/Recipe');
  const failureTitle = await canvas.findByText(englishMessages.recipeMethod, { selector: '[data-slot="alert-title"]' });
  const failure = failureTitle.closest<HTMLElement>('[role="alert"]')!;
  const retry = within(failure).getByRole('button', { name: englishMessages.retry });
  await expect(retry).toBeEnabled();
  const primary = within(canvas.getByRole('group', { name: englishMessages.primaryActions }));
  await expect(primary.getByRole('button', { name: englishMessages.cookThis })).toBeDisabled();
  expect(canvas.queryByText(englishMessages.recipeUnstructured)).toBeNull();
  expect(canvas.queryByRole('button', { name: 'Want to read' })).toBeNull();
  await userEvent.click(retry);
  await canvas.findAllByText('Stir', { exact: false });
  await waitFor(() => expect(canvas.queryByText(englishMessages.recipeMethod, { selector: '[data-slot="alert-title"]' })).toBeNull());
  expect(canvasElement.querySelector('[data-subject-header]')).toBe(subject);
  expect(subject).toHaveAttribute('data-resource', identity.header.id);
  expect(subject).toHaveAttribute('data-semantic-type', 'https://schema.org/Recipe');
  expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent(identity.header.title.value);
  const reads = canvasElement.querySelector('[data-frame-method-failures]')!;
  // The browser replay has no RSC request cache: region and frame each read once.
  // Both refused reads remain bounded; all snapshots retain the same native selection.
  expect(Number(reads.getAttribute('data-frame-method-failures'))).toBe(2);
  const requests = JSON.parse(reads.getAttribute('data-frame-method-requests')!) as string[];
  expect(requests).toHaveLength(4);
  expect(new Set(requests).size).toBe(1);
  expect(new URL(requests[0]!, window.location.origin).searchParams.get('actingSubject')).toBe(identity.actingSubject);
  const cook = primary.getByRole('button', { name: englishMessages.cookThis });
  await expect(cook).toBeEnabled();
  await userEvent.click(cook);
  const dialog = await canvas.findByRole('dialog', { name: englishMessages.cookMode });
  expect(within(dialog).getAllByText('Stir', { exact: false }).length).toBeGreaterThan(0);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(canvas.queryByRole('dialog')).toBeNull());
  await expect(cook).toHaveFocus();
  expect(canvasElement.querySelector('[data-replay-miss]')).toBeNull();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
}

export const PendingFrameAuxiliaries: Story = { args: { auxiliaries: 'pending' },
  render: args => <RecipeRecovery key={args.auxiliaries} {...args} />,
  play: async ({ canvasElement }) => {
  await waitFor(() => expect(canvasElement.querySelector('[data-frame-auxiliaries]')).toHaveAttribute('data-frame-auxiliaries', 'pending'));
  await recoverFrameMethod(canvasElement);
  const canvas = within(canvasElement);
  expect(canvas.getByRole('status', { name: englishMessages.savedStatus })).toHaveAttribute('aria-busy', 'true');
  expect(canvas.getByRole('status', { name: englishMessages.artwork })).toHaveAttribute('aria-busy', 'true');
  expect(canvas.getByRole('status', { name: englishMessages.sourcesAndEvidence })).toHaveAttribute('aria-busy', 'true');
  expect(canvas.queryByRole('button', { name: englishMessages.wantToCook })).toBeNull();
} };

export const UnavailableFrameAuxiliariesPhone: Story = { args: { auxiliaries: 'unavailable' },
  render: args => <RecipeRecovery key={args.auxiliaries} {...args} />,
  globals: { viewport: { value: 'phone' } }, play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('[data-frame-auxiliaries]')).toHaveAttribute('data-frame-auxiliaries', 'unavailable'));
    await recoverFrameMethod(canvasElement);
    const canvas = within(canvasElement);
    await canvas.findByText(englishMessages.savedStatus, { selector: '[data-slot="alert-title"]' });
    expect(canvas.getByText(englishMessages.artwork, { selector: '[data-slot="alert-title"]' })).toBeVisible();
    expect(canvas.getByText(englishMessages.ratings, { selector: '[data-slot="alert-title"]' })).toBeVisible();
    await userEvent.click(canvas.getByText(englishMessages.fullFacts, { selector: '[data-full-facts] > summary' }));
    expect(canvas.getAllByText(englishMessages.regionUnavailable).length).toBeGreaterThanOrEqual(3);
    expect(canvas.queryByRole('button', { name: englishMessages.wantToCook })).toBeNull();
    canvasElement.querySelector('#recipe-experience')?.scrollIntoView();
  } };

/** Contract-shaped fault injection around the captured production reader/region.
 * This focused parent has one method read per snapshot, like the RSC request cache.
 * Route refresh only supplies that snapshot; RSC delivery is not emulated here. */
function BoundedMethodRecovery({ transport }: { transport: 'network' | 'refusal' }) {
  const [snapshot, setSnapshot] = useState<{
    node: ReactNode; refresh: () => void; attempts: number; refreshes: number; requests: string[];
  } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let refreshes = 0;
    const requests: string[] = [];
    const note = (error: unknown) => { if (live) setFault(String(error)); };
    const visit = instructionVisitTransport('visitor', window.location.origin, async source => {
      if (source !== 'tests/fixtures/recipes/original-tomato-method.wav') throw new Error(`Unregistered asset ${source}`);
      const response = await fetch(recordingAsset);
      if (!response.ok) throw new Error('Recording fixture unavailable');
      return new Uint8Array(await response.arrayBuffer());
    }, note);
    const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith(`/recipes/works/${visit.id}`)) {
        requests.push(`${url.pathname}${url.search}`);
        if (refreshes === 0 || transport === 'refusal' && refreshes === 1) {
          if (transport === 'network') throw new TypeError('Injected connection loss');
          return Response.json({ code: 'specific_refusal' }, { status: 503 });
        }
      }
      return visit.fetcher(input, init);
    }, { preconnect: fetch.preconnect });
    const main = browserMainApi(window.location.origin, { anonymous: true, fetcher });
    const host = { ...visit.host, main, recordingFetch: fetcher,
      recipeReadPage: (href: string) => recipePageReader({ main, actingSubject: visit.actingSubject }, href) };
    const compose = async () => {
      const [types, projection] = await Promise.all([
        main.v1.types.get(), main.v1.resources({ resource: visit.id }).page.get(),
      ]);
      if (!types.data || types.error || !projection.data || projection.error) throw new Error('Captured identity unavailable');
      seedTypes(types.data);
      const experience = workExperience(projection.data, visit.header.types);
      const href = experience.typeSection?.href;
      if (!href || experience.kind !== 'recipe') throw new Error('Captured projection has no Recipe link');
      const method = await recipeRegion({ host, id: visit.id, work: visit.header, href, locale: 'en', messages: englishMessages });
      const node = <WorkFrame workRef={visit.id} work={visit.header} experience={experience} credits={null}
        locale="en" messages={englishMessages} signInHref="/auth/start"
        readAction={<WorkKindActions kind="recipe" workId={visit.header.id} workRef={visit.id} title={visit.header.title.value}
          locale="en" messages={englishMessages} recipeHref={href} canCook={false} />}>
        {method}
      </WorkFrame>;
      if (live) setSnapshot({ node, attempts: requests.length, refreshes, requests: [...requests],
        refresh: () => { refreshes++; void compose().catch(note); } });
    };
    setSnapshot(null); setFault(null);
    void compose().catch(note);
    return () => { live = false; visit.dispose(); };
  }, [transport]);
  if (fault) return <p role="alert" data-replay-miss>{fault}</p>;
  if (!snapshot) return <p role="status" aria-busy="true">{englishMessages.loading}</p>;
  return <div data-method-attempts={snapshot.attempts} data-method-refreshes={snapshot.refreshes}
    data-method-requests={JSON.stringify(snapshot.requests)}>
    <StoryRouteContext value={{ pathname: workHref(instructionVisitIdentity('visitor').id),
      search: 'language=en', onRefresh: snapshot.refresh }}>
      {snapshot.node}
    </StoryRouteContext>
  </div>;
}

export const NetworkRetryBounded: Story = {
  render: () => <BoundedMethodRecovery transport="network" />,
  play: async ({ canvasElement }) => {
    await failedSection(canvasElement);
    const reads = canvasElement.querySelector('[data-method-attempts]')!;
    expect(reads).toHaveAttribute('data-method-attempts', '2');
    await recover(canvasElement);
    expect(reads).toHaveAttribute('data-method-attempts', '3');
    const requests = JSON.parse(reads.getAttribute('data-method-requests')!) as string[];
    expect(new Set(requests).size).toBe(1);
  },
};

export const RefusedRetryThenRecovery: Story = {
  render: () => <BoundedMethodRecovery transport="refusal" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await failedSection(canvasElement);
    const title = canvas.getByRole('heading', { level: 1 });
    const shelf = canvas.getByRole('link', { name: new RegExp(`^${englishMessages.wantToCook}`) });
    const reads = canvasElement.querySelector('[data-method-attempts]')!;
    expect(reads).toHaveAttribute('data-method-attempts', '1');
    await userEvent.click(retry);
    await waitFor(() => expect(reads).toHaveAttribute('data-method-refreshes', '1'));
    expect(reads).toHaveAttribute('data-method-attempts', '2');
    await failedSection(canvasElement);
    await expect(retry).toHaveFocus();
    expect(canvas.getByRole('heading', { level: 1 })).toBe(title);
    expect(canvas.getByRole('link', { name: new RegExp(`^${englishMessages.wantToCook}`) })).toBe(shelf);
    await recover(canvasElement);
    expect(reads).toHaveAttribute('data-method-attempts', '3');
    const requests = JSON.parse(reads.getAttribute('data-method-requests')!) as string[];
    expect(new Set(requests).size).toBe(1);
  },
};
