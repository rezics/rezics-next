import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { chooseOption } from '../stories/choose-option.ts';
import { messages as workMessages } from '../work-page/messages.ts';
import { YourEdition } from '../work-page/your-edition.tsx';
import type { EditionPageQuery, TrackingApi } from './api.ts';
import * as fixture from './fixtures.ts';
import { createMemoryMain, memoryReader, memoryTracking } from './memory.ts';
import { copyOf } from './messages.ts';
import { SeriesProgressPanel } from './series-progress-panel.tsx';
import type { EditionChoice, EditionPreference, Editions, Realization, Release } from './types.ts';

const t = copyOf('en');
const work = fixture.saoOne;
const savedRevision = fixture.iri('ed2101');
const currentRevision = fixture.iri('ed2102');
type Kind = NonNullable<EditionChoice['edition']>['kind'];

/** Catalogue revision two must not replace the reader's independently saved revision one. */
function preferenceFixture(kind: Kind, saved = true, failOnce = false, unavailableChoice = false) {
  const releases: Release[] = kind === 'release' ? Array.from({ length: 21 }, (_, index) => ({
    ...fixture.editions.releases[0]!, id: fixture.iri(`ed${index + 1}`),
    revision: index === 20 ? currentRevision : fixture.iri(`ed${index + 1}02`),
    title: { value: `Release ${index + 1}`, language: index === 20 ? 'pl' : 'en' },
    contentLanguages: [index === 20 ? 'pl' : 'en'],
  })) : [];
  const realizations: Realization[] = kind === 'realization' ? Array.from({ length: 21 }, (_, index) => ({
    ...fixture.editions.realizations[1]!, id: fixture.iri(`ed${index + 1}`),
    revision: index === 20 ? currentRevision : fixture.iri(`ed${index + 1}02`),
    language: index === 20 ? 'pl' : 'en',
  })) : [];
  const main = createMemoryMain({ editions: { releases, realizations, more: false }, summaries: {
    en: { ...fixture.caughtUpSummary, resource: work, language: 'en' },
    pl: { ...fixture.caughtUpSummary, resource: work, language: 'pl' },
  } });
  const edition: NonNullable<EditionChoice['edition']> = { kind, resource: fixture.iri('ed21'), revision: savedRevision };
  const initial: EditionPreference = { work, language: saved ? 'pl' : 'en', edition: saved ? edition : null, version: 1 };
  main.preferences.set(work, initial);
  const reads: (EditionPageQuery | undefined)[] = [];
  const writes: EditionChoice[] = [];
  const preferenceReads: string[] = [];
  const editionReads: { work: string; choice: NonNullable<EditionChoice['edition']> }[] = [];
  let failures = failOnce ? 1 : 0;
  const base = memoryTracking(main);
  const api: TrackingApi = {
    ...base,
    async edition(resource, choice) {
      editionReads.push({ work: resource, choice });
      if (unavailableChoice) return { ok: false, failure: 'unavailable' };
      const found = releases.find(item => item.id === choice.resource) ?? realizations.find(item => item.id === choice.resource);
      return found ? { ok: true, data: found } : { ok: false, failure: 'missing' };
    },
    async preference(resource) {
      preferenceReads.push(resource);
      return base.preference(resource);
    },
    async setPreference(resource, expectedVersion, choice) {
      writes.push(choice);
      return base.setPreference(resource, expectedVersion, choice);
    },
    async editions(_resource, page) {
      reads.push(page);
      const cursor = page?.releases ?? page?.realizations;
      if (cursor && failures > 0) {
        failures -= 1;
        return { ok: false, failure: 'unavailable' };
      }
      const start = cursor ? Number(cursor) : 0;
      const next = start === 0 ? '20' : null;
      const data: Editions = { releases: releases.slice(start, start + 20),
        realizations: realizations.slice(start, start + 20),
        releasesCursor: kind === 'release' ? next : null,
        realizationsCursor: kind === 'realization' ? next : null, more: next !== null };
      return { ok: true, data };
    },
  };
  return { main, api, kind, edition, reads, writes, preferenceReads, editionReads, unavailableChoice };
}

function languageProgressFixture(state: 'loading' | 'unavailable') {
  const source = preferenceFixture('realization', false);
  const series = source.api.series;
  source.api = { ...source.api, async series(resource, language) {
    if (language === 'pl') {
      if (state === 'unavailable') return { ok: false, failure: 'unavailable' };
      return new Promise<Awaited<ReturnType<TrackingApi['series']>>>(() => {});
    }
    return series(resource, language);
  } };
  return source;
}

interface Args { surface: 'work' | 'series'; source: ReturnType<typeof preferenceFixture> }

/** Reopening discards the catalogue page while keeping only what Main persisted. */
function EditionPreference({ surface, source }: Args) {
  const [actions] = useState(() => ({ ...memoryReader(source.main), tracking: source.api }));
  const [opening, setOpening] = useState(0);
  return <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>
    <div className="mx-auto grid max-w-2xl gap-4 px-4 py-8">
      <button type="button" className="justify-self-start text-sm underline" onClick={() => setOpening(value => value + 1)}>
        Reopen choice
      </button>
      {surface === 'work' ? <section key={opening} aria-label="Your edition">
        <h2 className="mb-3 font-semibold text-lg">Your edition</h2>
        <YourEdition work={work} signInHref="/auth/start" locale="en" messages={workMessages.en} />
      </section> : <SeriesProgressPanel key={opening} work={work} locale="en" />}
    </div>
  </ReaderActionsProvider>;
}

type Scope = ReturnType<typeof within>;
async function choose(canvas: Scope, name: string, option: string) {
  await userEvent.click(canvas.getByRole('combobox', { name }));
  await chooseOption(within(document.body), option);
}

const continuation = (source: Args['source']): EditionPageQuery => source.kind === 'release'
  ? { releases: '20' } : { realizations: '20' };
const laterName = (source: Args['source']) => source.kind === 'release'
  ? 'Release 21 · paperback · Polish · Yen Press · 2014' : 'Polish translation';

async function saveUnchanged(canvas: Scope, source: Args['source'], count: number) {
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await waitFor(async () => {
    await expect(source.writes).toHaveLength(count);
    await expect(source.main.preferences.get(work)).toEqual({ work, language: 'pl', edition: source.edition, version: count + 1 });
  });
  await expect(source.writes[count - 1]).toEqual({ language: 'pl', edition: source.edition });
  await expect(canvas.getByRole('status')).toHaveTextContent(t.preferenceSaved);
}

async function unchangedChoice(canvasElement: HTMLElement, source: Args['source']) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: t.edition });
  await expect(canvas.getByRole('combobox', { name: t.language })).toHaveTextContent('Polish');
  await expect(source.preferenceReads).toEqual([work]);
  await expect(source.editionReads).toEqual([{ work, choice: source.edition }]);
  await expect(source.reads).toEqual([undefined]);
  await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(laterName(source));
  await saveUnchanged(canvas, source, 1);

  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await waitFor(() => expect(canvas.queryByRole('button', { name: t.moreEditions })).toBeNull());
  await expect(source.reads).toEqual([undefined, continuation(source)]);
  await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(laterName(source));
  await saveUnchanged(canvas, source, 2);

  await userEvent.click(canvas.getByRole('button', { name: 'Reopen choice' }));
  await canvas.findByRole('combobox', { name: t.edition });
  await expect(source.preferenceReads).toEqual([work, work]);
  await expect(source.editionReads).toEqual([{ work, choice: source.edition }, { work, choice: source.edition }]);
  await saveUnchanged(canvas, source, 3);

  await choose(canvas, t.edition, t.anyEdition);
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await waitFor(() => expect(source.main.preferences.get(work)).toEqual({ work, language: 'pl', edition: null, version: 5 }));
  await expect(source.writes[3]).toEqual({ language: 'pl', edition: null });
  await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(t.anyEdition);
}

async function failedContinuation(canvasElement: HTMLElement, source: Args['source'], recover: boolean) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: t.edition });
  await expect(source.editionReads).toEqual([{ work, choice: source.edition }]);
  await expect(canvas.getByRole('combobox', { name: t.edition }))
    .toHaveTextContent(source.unavailableChoice ? t.unnamedEdition : laterName(source));
  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await expect(await canvas.findByRole('alert')).toHaveTextContent(t.moreEditionsFailed);
  await expect(canvas.getByRole('button', { name: t.retry })).toBeVisible();
  await expect(source.main.preferences.get(work)?.edition).toEqual(source.edition);
  await expect(source.writes).toHaveLength(0);
  await saveUnchanged(canvas, source, 1);
  await expect(canvas.getByRole('alert')).toHaveTextContent(t.moreEditionsFailed);
  if (recover) {
    await userEvent.click(canvas.getByRole('button', { name: t.retry }));
    await waitFor(() => expect(canvas.queryByRole('alert')).toBeNull());
    await expect(source.reads).toEqual([undefined, continuation(source), continuation(source)]);
    await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(laterName(source));
    await saveUnchanged(canvas, source, 2);
  }
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

async function laterLanguage(canvasElement: HTMLElement, source: Args['source']) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: t.edition });
  await expect(canvas.getByRole('combobox', { name: t.language })).toHaveTextContent('English');
  await expect(source.editionReads).toHaveLength(0);
  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await waitFor(() => expect(canvas.queryByRole('button', { name: t.moreEditions })).toBeNull());
  await choose(canvas, t.language, 'Polish');
  await choose(canvas, t.edition, laterName(source));
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await waitFor(() => expect(source.main.preferences.get(work)).toEqual({ work, language: 'pl',
    edition: { ...source.edition, revision: currentRevision }, version: 2 }));
  await expect(canvas.getByRole('status')).toHaveTextContent(t.preferenceSaved);
}

const meta = { title: 'Tracking/Edition preference', component: EditionPreference,
  args: { surface: 'work', source: preferenceFixture('release') },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof EditionPreference>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SavedReleaseSurvives: Story = {
  args: { surface: 'work', source: preferenceFixture('release') },
  async play({ canvasElement, args }) { await unchangedChoice(canvasElement, args.source); },
};

export const SavedRealizationSurvives: Story = {
  args: { surface: 'series', source: preferenceFixture('realization') },
  async play({ canvasElement, args }) { await unchangedChoice(canvasElement, args.source); },
};

export const WorkContinuationRetry: Story = {
  args: { surface: 'work', source: preferenceFixture('release', true, true) },
  async play({ canvasElement, args }) { await failedContinuation(canvasElement, args.source, true); },
};

export const SeriesContinuationRetry: Story = {
  args: { surface: 'series', source: preferenceFixture('realization', true, true) },
  async play({ canvasElement, args }) { await failedContinuation(canvasElement, args.source, true); },
};

export const WorkContinuationUnavailable: Story = {
  args: { surface: 'work', source: preferenceFixture('release', true, true, true) },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement, args }) { await failedContinuation(canvasElement, args.source, false); },
};

export const SeriesContinuationUnavailable: Story = {
  args: { surface: 'series', source: preferenceFixture('realization', true, true, true) },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement, args }) { await failedContinuation(canvasElement, args.source, false); },
};

export const WorkLaterLanguage: Story = {
  args: { surface: 'work', source: preferenceFixture('release', false) },
  async play({ canvasElement, args }) { await laterLanguage(canvasElement, args.source); },
};

export const SeriesLaterLanguage: Story = {
  args: { surface: 'series', source: preferenceFixture('realization', false) },
  async play({ canvasElement, args }) { await laterLanguage(canvasElement, args.source); },
};

export const SeriesLanguageLoading: Story = {
  args: { surface: 'series', source: languageProgressFixture('loading') },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('combobox', { name: t.edition });
    await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: t.moreEditions })).toBeNull());
    await choose(canvas, t.language, 'Polish');
    const panel = canvas.getByRole('region', { name: t.seriesProgress });
    await expect(panel).toHaveAttribute('aria-busy', 'true');
    await expect(panel.querySelector('[data-slot="skeleton"]')).toBeVisible();
    await choose(canvas, t.edition, laterName(args.source));
    await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent('Polish translation');
    await expect(args.source.writes).toHaveLength(0);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const SeriesLanguageUnavailable: Story = {
  args: { surface: 'series', source: languageProgressFixture('unavailable') },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('combobox', { name: t.edition });
    await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
    await waitFor(() => expect(canvas.queryByRole('button', { name: t.moreEditions })).toBeNull());
    await choose(canvas, t.language, 'Polish');
    await expect(await canvas.findByRole('alert')).toHaveTextContent(t.seriesUnavailable);
    await choose(canvas, t.edition, laterName(args.source));
    await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
    await waitFor(() => expect(args.source.main.preferences.get(work)).toEqual({ work, language: 'pl',
      edition: { ...args.source.edition, revision: currentRevision }, version: 2 }));
    await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent('Polish translation');
    await expect(canvas.getByRole('status')).toHaveTextContent(t.preferenceSaved);
    await expect(canvas.getByRole('alert')).toHaveTextContent(t.seriesUnavailable);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
