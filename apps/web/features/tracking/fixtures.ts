import type { Editions, Relations, SeriesSummary, Session } from './types.ts';

// Records in the shape Main answers, for stories and tests: Sword Art Online volume 1 with a print
// and an audiobook release, and the Index "Original" series as it stands in zh-Hant.

export const iri = (id: string) => `https://rezics.com/id/00000000-0000-7000-8000-${id.padStart(12, '0')}`;
export const position = { dataEpoch: 'epoch', sequence: '1' };

export const saoOne = iri('1');
export const saoOneTitle = 'Sword Art Online, Vol. 1';

const target = (resource: string, base: Session['target']['base'], work = saoOne): Session['target'] => ({
  resource, base, types: [], work, revision: iri(`${resource.slice(-3)}9`), disclosure: 'public' });

export const session = (overrides: Partial<Session> = {}): Session => ({
  id: iri('a01'), target: target(saoOne, 'work'), state: 'active', startedOn: '2026-09', finishedOn: null,
  selections: [{ target: target(saoOne, 'work'), language: null, format: null, progress: 'locator' }], locators: [],
  completedAt: null, version: 1, createdAt: '2026-09-01T00:00:00.000Z', changedAt: '2026-09-01T00:00:00.000Z', ...overrides });

export const editions: Editions = {
  realizations: [
    { id: iri('r1'), revision: iri('r19'), language: 'ja', kind: 'original' },
    { id: iri('r2'), revision: iri('r29'), language: 'en', kind: 'translation' },
  ] as unknown as Editions['realizations'],
  releases: [
    { id: iri('p1'), revision: iri('p19'), title: { value: 'Sword Art Online 1: Aincrad', language: 'en' }, platform: 'paperback',
      contentLanguages: ['en'] },
    { id: iri('p2'), revision: iri('p29'), title: { value: 'Sword Art Online 1 (audiobook)', language: 'en' }, platform: 'audiobook',
      contentLanguages: ['en'] },
  ] as unknown as Editions['releases'],
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

/** Web Spider's relations: the book is recorded as its equivalent counterpart, a partial one is another Work. */
export const spiderRelations = (counterpart = book, title = 'So I’m a Spider, So What? (book)'): Relations => ({
  profile: 'resource-relations-v1', resource: web, next: null, sourcePosition: position,
  items: [{ relation: iri('x1'), kind: 'occurrence', revision: iri('x19'), evidence: null,
    counterparts: [{ reference: counterpart, status: 'available', type: 'work', base: 'work', work: counterpart, disclosure: 'public',
      name: { value: title, language: 'en', direction: 'ltr' }, avatar: null }],
    rendering: { profile: 'relation-rendering-v1', meaning: { definition: equivalentDefinition, revision: iri('d19'), lifecycle: 'active', roles: [] },
      occurrence: null, viewingRole: 'source', bindings: [],
      projections: [{ fromRole: 'source', toRole: 'target', arguments: [{ role: 'target', type: 'resource',
        value: { kind: 'resource', ref: counterpart } }] }] } }],
}) as unknown as Relations;

export const spider = { web, book };
