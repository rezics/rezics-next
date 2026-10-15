import { useEffect, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import { englishMessages } from '../work-page/messages.ts';
import { recipeWorkFrame, recipeWorkOverview } from '../work-page/recipe-reading-recorded-page.tsx';
import { EVERYONE } from '../work-page/route.ts';
import { RegionSkeleton } from '../work-page/region.tsx';
import { loadRecipeAuthoring } from './authoring-page.ts';
import { RecipeAuthoringBody, RecipeAuthoringPending } from './authoring-page.tsx';
import { mainRecipeExportApi } from './export-api.ts';
import { instructionVisitTransport } from './instruction-recorded-fixture.ts';
import { messages } from './messages.ts';
import { readRecipeVisitFrame } from './recipe-authoring-recorded-page.ts';
import { RecipeExchange } from './recipe-exchange.tsx';
import { mainRelationships } from '../relationships/api.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { readAnimeReaderState } from '../work-page/anime-hub-recorded-page.ts';

const recordingAsset = new URL('../../../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url);
type Surface = 'reading' | 'editor' | 'exchange' | 'loading';

function RecordedInstructions({ persona, surface }: { persona: AnswerPersona; surface: Surface }) {
  const [node, setNode] = useState<ReactNode>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setNode(null); setFault(null);
    const note = (error: unknown) => { if (live) setFault(String(error)); };
    const visit = instructionVisitTransport(persona, window.location.origin, async source => {
      if (source !== 'tests/fixtures/recipes/original-tomato-method.wav') throw new Error(`Unregistered asset ${source}`);
      const response = await fetch(recordingAsset);
      if (!response.ok) throw new Error('Recording fixture unavailable');
      return new Uint8Array(await response.arrayBuffer());
    }, note, surface === 'loading');
    void (async () => {
      try {
        const frame = await readRecipeVisitFrame(visit.main, visit.fetcher,
          { actingSubject: visit.actingSubject, locale: 'en', origin: window.location.origin });
        if (!frame.ok) throw new Error(frame.detail);
        const relationships = visit.actingSubject ? mainRelationships(visit.actingSubject, { fetch: visit.fetcher }) : undefined;
        const seed = visit.actingSubject ? await readAnimeReaderState(visit.main, visit.actingSubject, visit.id) : null;
        const readerActions = visit.actingSubject ? createReaderStore({ actingSubject: visit.actingSubject,
          seed: seed ?? {}, main: () => visit.main }) : undefined;
        let body: ReactNode;
        if (surface === 'editor') {
          const view = await loadRecipeAuthoring(visit.main, { id: visit.id, actingSubject: visit.actingSubject, signedIn: persona !== 'visitor' });
          body = <RecipeAuthoringBody view={view} locale="en" workRef={visit.id} workHref={`/works/${visit.id}`}
            signInHref="/sign-in" main={() => visit.main} recordingFetch={visit.fetcher} />;
        } else if (surface === 'exchange') {
          body = <RecipeExchange structure={visit.page.structure} revision={visit.page.revision} actingSubject={visit.actingSubject ?? ''}
            locale="en" messages={messages.en} api={mainRecipeExportApi(() => visit.main)} allowImport={false} save={() => undefined} />;
        } else {
          const pending = recipeWorkOverview({ host: visit.host, workRef: visit.id, id: visit.id, work: visit.header,
            scope: EVERYONE, locale: 'en', messages: englishMessages });
          body = surface === 'loading' ? <RegionSkeleton id="recipe-loading" title={visit.header.title.value}
            label={englishMessages.loadingRegion} lines={5} /> : await pending;
          if (surface === 'loading') void pending.catch(note);
        }
        const rendered = await recipeWorkFrame({ host: visit.host, workRef: visit.id, id: visit.id, work: visit.header,
          locale: 'en', messages: englishMessages, children: body, relationships, readerActions });
        if (live) setNode(rendered);
      } catch (error) { note(error); }
    })();
    return () => { live = false; visit.dispose(); };
  }, [persona, surface]);
  if (fault) return <p role="alert" data-replay-miss className="whitespace-pre-wrap break-all p-6">{fault}</p>;
  return node ?? <RecipeAuthoringPending locale="en" />;
}

const meta = { title: 'Recipe/Recorded instruction forms', component: RecordedInstructions,
  args: { persona: 'visitor', surface: 'reading' }, parameters: { controls: { disable: true } },
  globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedInstructions>;
export default meta;
type Story = StoryObj<typeof meta>;

async function noMiss(canvasElement: HTMLElement) {
  await waitFor(() => expect(canvasElement.querySelector('[data-replay-miss]')).toBeNull());
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
}
async function reading({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await canvas.findAllByText('Stir', { exact: false });
  expect(canvas.queryByText('PRIVATE successor', { exact: false })).toBeNull();
  await userEvent.click(await canvas.findByRole('button', { name: englishMessages.openRecording }));
  await waitFor(() => expect(canvasElement.querySelector('audio[src^="blob:"]')).not.toBeNull());
  await noMiss(canvasElement);
}
export const ReadingDesktop: Story = { play: reading };
export const ReadingPhone: Story = { globals: { viewport: { value: 'phone' } }, play: reading };
export const LoadingPhone: Story = { args: { surface: 'loading' }, globals: { viewport: { value: 'phone' } } };
export const EditorDesktop: Story = { args: { persona: 'owner', surface: 'editor' }, play: async ({ canvasElement }) => {
  await within(canvasElement).findByRole('button', { name: 'Use these instructions' });
  await noMiss(canvasElement);
} };
export const EditorPhone: Story = { ...EditorDesktop, globals: { viewport: { value: 'phone' } } };
export const PreviewDesktop: Story = { args: { persona: 'owner', surface: 'editor' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const preview = await canvas.findByRole('button', { name: 'Preview' }, { timeout: 10_000 });
  await userEvent.click(preview);
  await canvas.findByText('PRIVATE successor', { exact: false });
  const recording = await canvas.findByRole('button', { name: englishMessages.openRecording });
  await userEvent.click(recording);
  await waitFor(() => expect(canvasElement.querySelector('audio[src^="blob:"]')).not.toBeNull());
  await noMiss(canvasElement);
} };
export const PreviewPhone: Story = { ...PreviewDesktop, globals: { viewport: { value: 'phone' } } };
export const PeerEditingRefused: Story = { args: { persona: 'member', surface: 'editor' }, play: async ({ canvasElement }) => {
  await waitFor(() => expect(canvasElement.textContent).toContain('edit'));
  expect(within(canvasElement).queryByRole('button', { name: 'Use these instructions' })).toBeNull();
  await noMiss(canvasElement);
} };
export const ExchangeDesktop: Story = { args: { persona: 'member', surface: 'exchange' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const download = await canvas.findByRole('button', { name: 'Download Schema.org JSON' });
  await waitFor(() => expect(download).toBeEnabled());
  await userEvent.click(download);
  await canvas.findByText('Information this format cannot preserve');
  await noMiss(canvasElement);
} };
export const ExchangePhone: Story = { ...ExchangeDesktop, globals: { viewport: { value: 'phone' } } };
export const VisitorExportRefused: Story = { args: { surface: 'exchange' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const download = await canvas.findByRole('button', { name: 'Download Schema.org JSON' });
  await waitFor(() => expect(download).toBeEnabled());
  await userEvent.click(download);
  await canvas.findByRole('alert');
  await noMiss(canvasElement);
} };
