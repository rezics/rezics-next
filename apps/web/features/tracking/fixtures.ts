import { direction } from '@rezics/main/language';
import type { Episode } from './episode-api.ts';
import type { Editions, Realization, Release, Relations, SeriesSummary, Session, WorkSummary } from './types.ts';

// Records in the shape Main answers, for stories and tests: Sword Art Online volume 1 with a print
// and an audiobook release, and the Index "Original" series as it stands in zh-Hant.

export const iri = (id: string) => `https://rezics.com/id/00000000-0000-7000-8000-${id.padStart(12, '0')}`;
export const position = { datasetId: 'product' as const, dataEpoch: 'epoch', sequence: '1' };

export const saoOne = iri('1');
export const saoOneTitle = 'Sword Art Online, Vol. 1';

const target = (resource: string, base: Session['target']['base'], work = saoOne): Session['target'] => ({
  resource, base, types: [], work, revision: iri(`${resource.slice(-3)}9`), disclosure: 'public' });

export const session = (overrides: Partial<Session> = {}): Session => ({
  id: iri('a01'), target: target(saoOne, 'work'), state: 'active', startedOn: '2026-09', finishedOn: null,
  selections: [{ target: target(saoOne, 'work'), language: null, format: null, progress: 'locator' }], locators: [],
  completedAt: null, version: 1, createdAt: '2026-09-01T00:00:00.000Z', changedAt: '2026-09-01T00:00:00.000Z', ...overrides });

const realization = (id: string, language: string, kind: Realization['kind']) => ({
  profile: 'realization-v1', id: iri(id), work: saoOne, revision: iri(`${id}9`), language, kind, translators: [], publishers: [],
  source: { kind: 'unresolved', work: saoOne }, status: 'official', verification: 'verified', evidence: null, legacy: null,
}) satisfies Realization;

const release = (id: string, title: string, platform: string) => ({
  profile: 'release-v2', id: iri(id), revision: iri(`${id}9`), kind: 'formal', status: 'official', contentLanguages: ['en'],
  isTranslation: true, originalLanguages: ['ja'], titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' },
  isbn13: null, editionStatement: null, publisher: 'Yen Press', publicationYear: 2014, originalUrl: null, fixedRelease: null,
  identifiers: [], platform, territory: 'US',
  coverage: [{ realization: iri('r2'), revision: iri('r29'), work: saoOne, mainVersion: iri('mv1'), language: 'en', completeness: 'complete' }],
  legacyCoverage: null, snapshots: [],
}) satisfies Release;

export const editions: Editions = {
  realizations: [realization('r1', 'ja', 'original'), realization('r2', 'en', 'translation')],
  releases: [release('p1', 'Sword Art Online 1: Aincrad', 'paperback'), release('p2', 'Sword Art Online 1 (audiobook)', 'audiobook')],
  more: false,
};

const part = (id: string, label: string, inclusion: 'required' | 'optional' | 'extra' = 'required', available = true) =>
  ({ occurrence: iri(`o${id}`), work: iri(id), displayLabel: label, inclusion, available });

/** Index "Original" in zh-Hant: caught up with what is available, yet not finished with the published parts. */
export const indexSummary: SeriesSummary = {
  resource: iri('100'), scope: 'disclosed-composition', policy: 'composition-progress-v2', language: 'zh-Hant',
  completedParts: [part('101', '1'), part('102', '2')],
  counts: { completed: 2, required: 4, completedRequired: 2 },
  states: { caughtUpWithAvailableMaterial: true, finishedPublishedParts: false, seriesConcluded: false, correspondenceUnresolved: true },
  next: { part: part('103', '3', 'required', false), reason: 'awaiting_chosen_language' },
  furthestCompleted: { part: part('102', '2'), occurrence: null, locator: { target: iri('102'), unit: 'page', current: 210, furthest: 240 } },
  partial: false, preference: { work: iri('100'), language: 'zh-Hant', edition: null, version: 1 },
  primaryAction: null,
  revisions: { composition: { structure: iri('c1'), revision: iri('c19') }, sessions: [], library: [], selections: [],
    graph: position },
  continuation: { parts: null, groups: [], sessions: null, releases: null },
};

/** A series in which the reader has read everything available and only optional parts remain. */
export const caughtUpSummary: SeriesSummary = {
  ...indexSummary, language: 'en', preference: null, completedParts: [part('101', '1'), part('102', '2'), part('103', '3')],
  counts: { completed: 3, required: 3, completedRequired: 3 },
  states: { caughtUpWithAvailableMaterial: true, finishedPublishedParts: true, seriesConcluded: null, correspondenceUnresolved: false },
  next: { part: part('104', 'Side story', 'optional'), reason: 'optional_extra' },
  furthestCompleted: { part: part('103', '3'), occurrence: null, locator: null },
};

/** A long series larger than one page of parts: Main reports no aggregate, and so does the panel. */
export const partialSummary: SeriesSummary = {
  ...indexSummary, partial: true,
  states: { caughtUpWithAvailableMaterial: null, finishedPublishedParts: null, seriesConcluded: null, correspondenceUnresolved: false },
  next: null, continuation: { ...indexSummary.continuation, parts: 'cursor' },
};

export const equivalentDefinition = iri('d1');
const web = iri('w1');
const book = iri('w2');

// Main's resource `type` is a registry-defined union that the contract types as `never`; 'work' is what it answers.
/** Web Spider's relations: the book is recorded as its equivalent counterpart. */
export const spiderRelations = (counterpart = book, title = 'So I’m a Spider, So What? (book)') => ({
  profile: 'resource-relations-v1', resource: web, next: null, sourcePosition: position,
  items: [{ relation: iri('x1'), kind: 'occurrence', revision: iri('x19'), evidence: null,
    counterparts: [{ reference: counterpart, status: 'available', type: 'work' as never, base: 'work', work: counterpart, disclosure: 'public',
      address: { prefix: '/w/',key: 'spider-book',suffixSource: title },
      name: { value: title, language: 'en', direction: direction('en', title), basis: 'requested' },
      avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: counterpart, resourceType: 'work' as never } }],
    rendering: { profile: 'relation-rendering-v1', meaning: { definition: equivalentDefinition, revision: iri('d19'), lifecycle: 'active', roles: [] },
      occurrence: null, viewingRole: 'source', bindings: [],
      projections: [{ fromRole: 'source', toRole: 'target', presentation: null, labels: null, language: null, script: null,
        direction: null, reviewStatus: null, source: null, licence: null, fallback: null,
        arguments: [{ role: 'target', type: 'resource', value: { kind: 'resource', ref: counterpart } }] }] } }],
}) satisfies Relations;

/** A Work with no composition, as Main answers for it: its own status, no parts. */
export const standaloneSummary = (status: WorkSummary['status']) => ({
  resource: web, scope: 'work', policy: 'composition-progress-v2', language: null, status,
  counts: { completed: status === 'finished' ? 1 : 0, required: 1, completedRequired: status === 'finished' ? 1 : 0 },
  states: { correspondenceUnresolved: false }, partial: false, preference: null,
  revisions: { work: { resource: web, revision: iri('w19') }, sessions: [], library: [], selections: [], graph: position },
  continuation: { sessions: null, releases: null },
}) satisfies WorkSummary;

export const spider = { web, book };

/** A series' episodes as Main lists them in reading order: the main run, then a Specials group. */
export function episodeSeries(options: { mains: number; specials?: number; role?: 'part' | 'chapter' }): Episode[] {
  const structure = iri('e00');
  const group = iri('e01');
  const role = options.role ?? 'part';
  const main = Array.from({ length: options.mains }, (_, index): Episode => ({ occurrence: iri(`e1${index + 1}`), structure,
    parent: structure, role, ordinal: index + 1, label: null, special: false }));
  const extra = Array.from({ length: options.specials ?? 0 }, (_, index): Episode => ({ occurrence: iri(`e2${index + 1}`), structure,
    parent: group, role: 'part', ordinal: index + 1, label: `Special ${index + 1}`, special: true }));
  return [...main, ...extra];
}
