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
function preferenceFixture(kind: Kind, saved = true, failOnce = false, unavailableChoice = false,
  options: { count?: number; selected?: number; invalidated?: 'moved' | 'invalid' } = {}) {
  const count = options.count ?? 21;
  const selected = options.selected ?? 21;
  const releases: Release[] = kind === 'release' ? Array.from({ length: count }, (_, index) => ({
    ...fixture.editions.releases[0]!, id: fixture.iri(`ed${index + 1}`),
    revision: index + 1 === selected ? currentRevision : fixture.iri(`ed${index + 1}02`),
    title: { value: `Release ${index + 1}`, language: index + 1 === selected ? 'pl' : 'en' },
    contentLanguages: [index + 1 === selected ? 'pl' : 'en'],
  })) : [];
  const realizations: Realization[] = kind === 'realization' ? Array.from({ length: count }, (_, index) => ({
    ...fixture.editions.realizations[1]!, id: fixture.iri(`ed${index + 1}`),
    revision: index + 1 === selected ? currentRevision : fixture.iri(`ed${index + 1}02`),
    language: index + 1 === selected ? 'pl' : 'en',
  })) : [];
  const main = createMemoryMain({ editions: { releases, realizations, more: false }, summaries: {
    en: { ...fixture.caughtUpSummary, resource: work, language: 'en' },
    pl: { ...fixture.caughtUpSummary, resource: work, language: 'pl' },
  } });
  const edition: NonNullable<EditionChoice['edition']> = { kind, resource: fixture.iri(`ed${selected}`), revision: savedRevision };
  const initial: EditionPreference = { work, language: saved ? 'pl' : 'en', edition: saved ? edition : null, version: 1 };
  main.preferences.set(work, initial);
  const reads: (EditionPageQuery | undefined)[] = [];
  const writes: EditionChoice[] = [];
  const preferenceReads: string[] = [];
  const editionReads: { work: string; choice: NonNullable<EditionChoice['edition']> }[] = [];
  let failures = failOnce ? 1 : 0;
  let firstPages = 0;
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
      if (!cursor) firstPages++;
      if (cursor && options.invalidated && !cursor.startsWith('renewed:')) {
        return { ok: false, failure: options.invalidated };
      }
      if (cursor && failures > 0) {
        failures -= 1;
        return { ok: false, failure: 'unavailable' };
      }
      const start = cursor ? Number(cursor.split(':').at(-1)) : 0;
      const next = start + 20 < count ? `${options.invalidated && firstPages > 1 ? 'renewed:' : ''}${start + 20}` : null;
      const data: Editions = { releases: releases.slice(start, start + 20),
        realizations: realizations.slice(start, start + 20),
        releasesCursor: kind === 'release' ? next : null,
        realizationsCursor: kind === 'realization' ? next : null, more: next !== null };
      return { ok: true, data };
    },
  };
  return { main, api, kind, edition, reads, writes, preferenceReads, editionReads, unavailableChoice, selected };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function navigationFixture(kind: Kind) {
  const source = preferenceFixture(kind);
  const otherWork = fixture.iri('workb');
  const otherChoice: NonNullable<EditionChoice['edition']> = {
    kind, resource: fixture.iri('editionb'), revision: fixture.iri('revisionb'),
  };
  source.main.preferences.set(otherWork, { work: otherWork, language: 'de', edition: otherChoice, version: 7 });
  const readEdition = source.api.edition;
  const writePreference = source.api.setPreference;
  const pending = deferred<Awaited<ReturnType<TrackingApi['setPreference']>>>();
  let held: { work: string; version: number; choice: EditionChoice } | null = null;
  const started: string[] = [];
  source.api = { ...source.api,
    async edition(resource, choice) {
      if (resource !== otherWork) return readEdition(resource, choice);
      return { ok: true, data: kind === 'release'
        ? { ...fixture.editions.releases[0]!, id: otherChoice.resource, revision: otherChoice.revision,
          title: { value: 'Release B', language: 'de' }, contentLanguages: ['de'],
          coverage: fixture.editions.releases[0]!.coverage.map(item => ({ ...item, work: otherWork })) }
        : { ...fixture.editions.realizations[1]!, id: otherChoice.resource, revision: otherChoice.revision,
          work: otherWork, language: 'de' } };
    },
    async series(resource, language) {
      return { ok: true, data: { ...fixture.caughtUpSummary, resource, language: language ?? 'en' } };
    },
    async setPreference(resource, version, choice) {
      if (resource !== work) return writePreference(resource, version, choice);
      held = { work: resource, version, choice };
      started.push(resource);
      return pending.promise;
    },
  };
  return { source, otherWork, otherChoice, started,
    async complete() {
      if (!held) throw new Error('No save is pending.');
      pending.resolve(await writePreference(held.work, held.version, held.choice));
    },
  };
}

function returningFixture() {
  const source = preferenceFixture('release');
  const otherWork = fixture.iri('workb');
  const pending = deferred<Awaited<ReturnType<TrackingApi['preference']>>>();
  const preference = source.api.preference;
  const editions = source.api.editions;
  source.api = { ...source.api,
    async preference(resource) {
      if (resource !== otherWork) return preference(resource);
      source.preferenceReads.push(resource);
      return pending.promise;
    },
    async editions(resource, page) {
      return resource === otherWork ? { ok: true, data: { realizations: [], releases: [], more: false } }
        : editions(resource, page);
    },
  };
  return { source, otherWork,
    update() { source.main.preferences.set(work, { work, language: 'de', edition: null, version: 2 }); },
    complete: () => pending.resolve({ ok: true, data: null }),
  };
}

function pendingContinuationFixture(kind: Kind) {
  const source = preferenceFixture(kind);
  const read = source.api.editions;
  const pending = deferred<Awaited<ReturnType<TrackingApi['editions']>>>();
  let held = false;
  source.api = { ...source.api, async editions(resource, page) {
    if (page && !held) {
      held = true;
      source.reads.push(page);
      return pending.promise;
    }
    return read(resource, page);
  } };
  return { source, complete: () => pending.resolve({ ok: false, failure: 'moved' }) };
}

function pendingSetupFixture() {
  const source = preferenceFixture('release');
  const relations = { ...fixture.spiderRelations(), resource: work };
  const pending = deferred<Awaited<ReturnType<TrackingApi['relations']>>>();
  const relationReads: string[] = [];
  const progressReads: (string | null | undefined)[] = [];
  const series = source.api.series;
  source.api = { ...source.api,
    async relations(resource) {
      relationReads.push(resource);
      return pending.promise;
    },
    async series(resource, language) {
      progressReads.push(language);
      return series(resource, language);
    },
  };
  return { source, relationReads, progressReads, complete: () => pending.resolve({ ok: true, data: relations }) };
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

interface Args {
  surface: 'work' | 'series'; source: ReturnType<typeof preferenceFixture>;
  navigation?: ReturnType<typeof navigationFixture>;
  returning?: ReturnType<typeof returningFixture>;
  pendingContinuation?: ReturnType<typeof pendingContinuationFixture>;
  pendingSetup?: ReturnType<typeof pendingSetupFixture>;
}

/** Reopening discards the catalogue page while keeping only what Main persisted. */
function EditionPreference({ surface, source, navigation, returning, pendingSetup }: Args) {
  const [actions] = useState(() => ({ ...memoryReader(source.main, pendingSetup ? { [work]: 'read' } : {}), tracking: source.api }));
  const [opening, setOpening] = useState(0);
  const [selectedWork, setSelectedWork] = useState(work);
  return <ReaderActionsProvider signedIn signInHref="/auth/start" actions={actions}>
    <div className="mx-auto grid max-w-2xl gap-4 px-4 py-8">
      <button type="button" className="justify-self-start text-sm underline" onClick={() => setOpening(value => value + 1)}>
        Reopen choice
      </button>
      {navigation || returning ? <button type="button" className="justify-self-start text-sm underline"
        onClick={() => setSelectedWork((navigation ?? returning)!.otherWork)}>Switch to Work B</button> : null}
      {returning ? <button type="button" className="justify-self-start text-sm underline"
        onClick={() => setSelectedWork(work)}>Return to Work A</button> : null}
      {surface === 'work' ? <section key={opening} aria-label="Your edition">
        <h2 className="mb-3 font-semibold text-lg">Your edition</h2>
        <YourEdition work={selectedWork} signInHref="/auth/start" locale="en" messages={workMessages.en} />
      </section> : <SeriesProgressPanel key={opening} work={selectedWork} locale="en" />}
      {pendingSetup ? <SeriesProgressPanel work={selectedWork} locale="en" preferenceForm={false} /> : null}
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
  ? `Release ${source.selected} · paperback · Polish · Yen Press · 2014` : 'Polish translation';

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
  await expect(source.editionReads.length).toBeGreaterThanOrEqual(2);
  await expect(source.editionReads.every(read => read.work === work && read.choice.resource === source.edition.resource
    && read.choice.revision === source.edition.revision)).toBe(true);
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

async function lateSave(canvasElement: HTMLElement, navigation: ReturnType<typeof navigationFixture>, surface: Args['surface']) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: t.edition });
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await waitFor(() => expect(navigation.started).toEqual([work]));
  await userEvent.click(canvas.getByRole('button', { name: 'Switch to Work B' }));
  await waitFor(() => expect(canvas.getByRole('combobox', { name: t.language })).toHaveTextContent('German'));
  const name = navigation.otherChoice.kind === 'release'
    ? 'Release B · paperback · German · Yen Press · 2014' : 'German translation';
  await waitFor(() => expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(name));
  await navigation.complete();
  await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(name);
  await expect(canvas.getByRole('combobox', { name: t.language })).toHaveTextContent('German');
  if (surface === 'series') await expect(canvas.getByRole('region', { name: t.seriesProgress })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await waitFor(() => expect(navigation.source.main.preferences.get(navigation.otherWork)).toEqual({
    work: navigation.otherWork, language: 'de', edition: navigation.otherChoice, version: 8,
  }));
  await expect(canvas.getByRole('status')).toHaveTextContent(t.preferenceSaved);
}

async function invalidatedContinuation(canvasElement: HTMLElement, source: Args['source']) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: t.edition });
  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await expect(await canvas.findByRole('alert')).toHaveTextContent(t.moreEditionsFailed);
  await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(laterName(source));
  await userEvent.click(canvas.getByRole('button', { name: t.retry }));
  await waitFor(() => expect(source.reads).toHaveLength(3));
  await expect(source.reads[2]).toBeUndefined();
  await userEvent.click(await canvas.findByRole('button', { name: t.moreEditions }));
  await waitFor(() => expect(canvas.queryByRole('button', { name: t.moreEditions })).toBeNull());
  await expect(source.reads).toEqual([undefined, continuation(source), undefined,
    source.kind === 'release' ? { releases: 'renewed:20' } : { realizations: 'renewed:20' }]);
  await saveUnchanged(canvas, source, 1);
  await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(laterName(source));
}

async function thirdPageLanguage(canvasElement: HTMLElement, source: Args['source']) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: t.edition });
  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await waitFor(() => expect(source.reads).toHaveLength(2));
  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await waitFor(() => expect(canvas.queryByRole('button', { name: t.moreEditions })).toBeNull());
  await expect(source.reads).toEqual([undefined, continuation(source),
    source.kind === 'release' ? { releases: '40' } : { realizations: '40' }]);
  await choose(canvas, t.language, 'Polish');
  await choose(canvas, t.edition, laterName(source));
  await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
  await waitFor(() => expect(source.main.preferences.get(work)).toEqual({ work, language: 'pl',
    edition: { ...source.edition, revision: currentRevision }, version: 2 }));
  await expect(canvas.getByRole('status')).toHaveTextContent(t.preferenceSaved);
}

async function oldVersionContinuation(canvasElement: HTMLElement, pending: ReturnType<typeof pendingContinuationFixture>) {
  const canvas = within(canvasElement);
  await canvas.findByRole('combobox', { name: t.edition });
  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await waitFor(() => expect(pending.source.reads).toHaveLength(2));
  await saveUnchanged(canvas, pending.source, 1);
  pending.complete();
  await waitFor(() => expect(canvas.getByRole('button', { name: t.moreEditions })).toBeEnabled());
  await expect(canvas.queryByRole('alert')).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: t.moreEditions }));
  await waitFor(() => expect(canvas.queryByRole('button', { name: t.moreEditions })).toBeNull());
  await expect(pending.source.reads).toEqual([undefined, continuation(pending.source), continuation(pending.source)]);
  await saveUnchanged(canvas, pending.source, 2);
}

const workNavigation = navigationFixture('release');
export const WorkLateSaveStaysWithItsWork: Story = {
  args: { surface: 'work', source: workNavigation.source, navigation: workNavigation },
  async play({ canvasElement, args }) { await lateSave(canvasElement, args.navigation!, 'work'); },
};

const seriesNavigation = navigationFixture('realization');
export const SeriesLateSaveStaysWithItsWork: Story = {
  args: { surface: 'series', source: seriesNavigation.source, navigation: seriesNavigation },
  async play({ canvasElement, args }) { await lateSave(canvasElement, args.navigation!, 'series'); },
};

export const WorkMovedCursorRestarts: Story = {
  args: { surface: 'work', source: preferenceFixture('release', true, false, false, { invalidated: 'moved' }) },
  async play({ canvasElement, args }) { await invalidatedContinuation(canvasElement, args.source); },
};

export const SeriesUnknownCursorRestarts: Story = {
  args: { surface: 'series', source: preferenceFixture('realization', true, false, false, { invalidated: 'invalid' }) },
  async play({ canvasElement, args }) { await invalidatedContinuation(canvasElement, args.source); },
};

export const SeriesMovedCursorRestarts: Story = {
  args: { surface: 'series', source: preferenceFixture('realization', true, false, false, { invalidated: 'moved' }) },
  async play({ canvasElement, args }) { await invalidatedContinuation(canvasElement, args.source); },
};

export const WorkUnknownCursorRestarts: Story = {
  args: { surface: 'work', source: preferenceFixture('release', true, false, false, { invalidated: 'invalid' }) },
  async play({ canvasElement, args }) { await invalidatedContinuation(canvasElement, args.source); },
};

export const WorkThirdPageLanguage: Story = {
  args: { surface: 'work', source: preferenceFixture('release', false, false, false, { count: 45, selected: 41 }) },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement, args }) { await thirdPageLanguage(canvasElement, args.source); },
};

export const SeriesThirdPageLanguage: Story = {
  args: { surface: 'series', source: preferenceFixture('realization', false, false, false, { count: 45, selected: 41 }) },
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement, args }) { await thirdPageLanguage(canvasElement, args.source); },
};

const workPending = pendingContinuationFixture('release');
export const WorkOldVersionContinuationIsDropped: Story = {
  args: { surface: 'work', source: workPending.source, pendingContinuation: workPending },
  async play({ canvasElement, args }) { await oldVersionContinuation(canvasElement, args.pendingContinuation!); },
};

const seriesPending = pendingContinuationFixture('realization');
export const SeriesOldVersionContinuationIsDropped: Story = {
  args: { surface: 'series', source: seriesPending.source, pendingContinuation: seriesPending },
  async play({ canvasElement, args }) { await oldVersionContinuation(canvasElement, args.pendingContinuation!); },
};

const pendingSetup = pendingSetupFixture();
export const WorkSaveBeforeRelationsKeepsCounterparts: Story = {
  args: { surface: 'work', source: pendingSetup.source, pendingSetup },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const pending = args.pendingSetup!;
    const offer = 'Also mark “So I’m a Spider, So What? (book)” as read';
    await canvas.findByRole('combobox', { name: t.edition });
    await expect(pending.relationReads).toEqual([work]);
    await expect(canvas.queryByRole('button', { name: offer })).toBeNull();
    await choose(canvas, t.language, 'English');
    await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.preferenceSaved);
    await expect(args.source.main.preferences.get(work)).toEqual({ work, language: 'en', edition: null, version: 2 });
    pending.complete();
    const panel = within(await canvas.findByRole('region', { name: t.seriesProgress }));
    await expect(await panel.findByRole('button', { name: offer })).toBeVisible();
    await expect(pending.relationReads).toEqual([work]);
    await expect(pending.progressReads.at(-1)).toBe('en');
    await expect(canvas.getByRole('combobox', { name: t.language })).toHaveTextContent('English');
    await expect(args.source.main.calls.started).toEqual([]);
  },
};

const returning = returningFixture();
export const SeriesReturnReadsCurrentPreference: Story = {
  args: { surface: 'series', source: returning.source, returning },
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    const returning = args.returning!;
    await canvas.findByRole('combobox', { name: t.edition });
    await expect(canvas.getByRole('combobox', { name: t.language })).toHaveTextContent('Polish');
    await userEvent.click(canvas.getByRole('button', { name: 'Switch to Work B' }));
    await waitFor(() => expect(args.source.preferenceReads).toEqual([work, returning.otherWork]));
    returning.update();
    await userEvent.click(canvas.getByRole('button', { name: 'Return to Work A' }));
    await waitFor(() => expect(args.source.preferenceReads).toEqual([work, returning.otherWork, work]));
    await waitFor(() => expect(canvas.getByRole('combobox', { name: t.language })).toHaveTextContent('German'));
    await expect(canvas.getByRole('region', { name: t.seriesProgress })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: t.edition })).toHaveTextContent(t.anyEdition);
    returning.complete();
    await userEvent.click(canvas.getByRole('button', { name: t.savePreference }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(t.preferenceSaved);
    await expect(args.source.main.preferences.get(work)).toEqual({ work, language: 'de', edition: null, version: 3 });
  },
};
