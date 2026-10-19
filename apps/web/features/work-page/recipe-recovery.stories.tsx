import { useEffect, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import { browserMainApi } from '../api/browser.ts';
import { seedTypes } from '../catalogue/types.ts';
import { instructionVisitIdentity, instructionVisitTransport } from '../recipe-editor/instruction-recorded-fixture.ts';
import { englishMessages } from './messages.ts';
import { recipePageReader } from './recipe-reading-recorded-page.ts';
import { recipeWorkFrame, recipeWorkOverview } from './recipe-reading-recorded-page.tsx';
import { EVERYONE, workHref } from './route.ts';

const recordingAsset = new URL('../../../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url);

/** The existing captured visit, with three supplemental reads held across a refresh.
 * Refresh composes the next owner snapshot; this does not simulate the RSC transport. */
function RecipeRecovery() {
  const [snapshot, setSnapshot] = useState<{ node: ReactNode; refresh: () => void } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let recovered = false;
    const gate = Promise.withResolvers<void>();
    const pending = new Set<Promise<Response>>();
    const note = (error: unknown) => { if (live) setFault(String(error)); };
    const visit = instructionVisitTransport('visitor', window.location.origin, async source => {
      if (source !== 'tests/fixtures/recipes/original-tomato-method.wav') throw new Error(`Unregistered asset ${source}`);
      const response = await fetch(recordingAsset);
      if (!response.ok) throw new Error('Recording fixture unavailable');
      return new Uint8Array(await response.arrayBuffer());
    }, note);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const read = (async () => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
        if (url.pathname.endsWith('/agent-credits') || url.pathname.endsWith('/selection')
          || /\/agents\/[^/]+\/works$/.test(url.pathname)) {
          await gate.promise;
        }
        // A definitive section refusal exercises the existing RetryButton. The
        // healthy snapshot uses the unchanged captured method and exact identity.
        if (!recovered && url.pathname.endsWith(`/recipes/works/${visit.id}`)) {
          return Response.json({ code: 'unavailable' }, { status: 503 });
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
      const overview = await recipeWorkOverview({ host, id: visit.id, workRef: visit.id, work: visit.header,
        scope: EVERYONE, locale: 'en', messages: englishMessages });
      const node = await recipeWorkFrame({ host, id: visit.id, workRef: visit.id, work: visit.header,
        locale: 'en', messages: englishMessages, children: overview });
      if (live) setSnapshot({ node, refresh: () => { recovered = true; void compose().catch(note); } });
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
  }, []);
  const identity = instructionVisitIdentity('visitor');
  if (fault) return <p role="alert" data-replay-miss>{fault}</p>;
  if (!snapshot) return <p role="status" aria-busy="true">{englishMessages.loading}</p>;
  return <StoryRouteContext value={{ pathname: workHref(identity.id), search: 'language=en', onRefresh: snapshot.refresh }}>
    {snapshot.node}
  </StoryRouteContext>;
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
