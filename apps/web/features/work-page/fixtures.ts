// Typed Main responses for the Work page's stories. Shapes come from the Eden
// types, so a contract change breaks the stories' build as well as the page's.
import type { WorkScope } from './route.ts';
import type { ScopeRealm, ScopeView } from './scope-bar.tsx';
import type { AdoptionPage, ClassificationPage, CreditPage, HistoryPage, Loaded, RatingContext, RatingRead,
  VersionPage, WorkHeader, WorkName } from './types.ts';

const iri = (uuid: string) => `https://rezics.com/id/${uuid}`;
const name = (value: string, language = 'en'): WorkName => ({ value, language, direction: 'ltr', basis: 'requested' });
const sourcePosition = { dataEpoch: '8c483e38-59e7-4d95-b27b-de9cd6742a3e', sequence: '4812' };
const page = <T>(items: T[], nextCursor: string | null = null) =>
  ({ items, nextCursor, sourcePosition, count: { value: items.length, kind: 'exact-page' as const, total: null } });
export const ok = <T>(data: T): Loaded<T> => ({ ok: true, data });

export const workRef = '5f7a2c1e-8d3b-4c6a-9e2f-1b4d6a8c0e3f';
const workId = iri(workRef);
const mainVersion = iri('0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d');
const realmA = '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';
const realmB = 'a2d4f6e8-1c3b-4a5d-9e7f-0b2c4d6e8f1a';
const globalContext = iri('c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c');

export const work: WorkHeader = {
  profile: 'work-read-v1', id: workId, revision: iri('e4a6c8b0-2d1f-4e3a-9c5b-7d9f1a3c5e7b'), mainVersion,
  title: name('The Cartographer of Tides'),
  cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: '3fa2c9d17b8e4a6f0c2d5e8b1a4f7c90', resourceType: 'work' },
  types: ['https://schema.org/Book'], disclosure: 'public', originalTitle: null,
  mainVersionRevision: iri('d3f5b7a9-1c2e-4d4f-8a6b-9c1e3f5a7b9d'), mainVersionLabel: null, selectedLanguage: 'en',
  sourcePosition, links: { versions: '', classifications: '', adoptions: '', ratings: '', history: '', credits: '' },
};

/** A Work recorded without text: private to its creator so far, no types, no cover. */
export const metadataOnlyWork: WorkHeader = { ...work, title: name('Untitled field notes'), types: [],
  disclosure: 'restricted', selectedLanguage: null,
  cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'b81f0e6a2c4d9e7f3a5b1c8d0e2f4a6b', resourceType: 'work' } };

export const cjkWork: WorkHeader = { ...work,
  title: { value: '潮汐制图师：关于一座由河流、运河与记忆构成的城市的漫长笔记（修订增补版）', language: 'zh-Hans',
    direction: 'ltr', basis: 'requested' }, selectedLanguage: 'zh-Hans' };

export const fallbackTitleWork: WorkHeader = { ...work, title: { ...work.title, basis: 'fallback' } };

export const credits = ok<CreditPage>(page([
  { id: iri('f1a3c5e7-9b0d-4f2a-8c4e-6a8c0e2a4c6e'), role: 'author', participantKind: 'external-reference',
    provider: 'open-library', key: '/authors/OL2162284A', ordinal: 0, agent: null, displayName: null, handle: null },
]));
export const noCredits = ok<CreditPage>(page([]));

const adoption = (realm: string, realmName: WorkName, language: string) => ({ realm: iri(realm), name: realmName,
  selection: iri('9d1b3f5a-7c9e-4b1d-a3f5-7b9d1f3a5c7e'), contribution: iri('8c0a2e4f-6b8d-4a0c-92e4-6a8c0e2f4b6d'),
  language });
export const adoptions = ok<AdoptionPage>(page([
  adoption(realmA, name('Tidewater Readers'), 'en'),
  adoption(realmB, name('海洋文学研究会', 'zh-Hans'), 'zh-Hans'),
]));
export const noAdoptions = ok<AdoptionPage>(page([]));
export const realms: ScopeRealm[] = [
  { id: realmA, name: name('Tidewater Readers') },
  { id: realmB, name: name('海洋文学研究会', 'zh-Hans') },
];

export const globalScope: WorkScope = { kind: 'global' };
export const realmScope: WorkScope = { kind: 'realm', realm: realmA };
export const mineScope: WorkScope = { kind: 'mine' };
export const scopeView = (scope: WorkScope, withRealms = realms): ScopeView => ({ workRef, scope, realms: withRealms });

const question = (context: string, text: string, max: number): RatingContext =>
  ({ context, question: text, language: 'en', scale: { min: 1, max, step: 1 } });
const globalQuestion = question(globalContext, 'How good is this Work overall?', 5);
const summary = (scope: WorkScope, context: RatingContext | null, counts: number[]) => {
  const count = counts.reduce((sum, value) => sum + value, 0);
  const total = counts.reduce((sum, value, index) => sum + value * (index + 1), 0);
  return { profile: 'work-rating-read-v1' as const, work: workId, mainVersion,
    scope: { kind: scope.kind, realm: scope.kind === 'realm' ? iri(scope.realm) : null },
    context: context?.context ?? null, status: context ? 'available' as const : 'no-context' as const,
    scale: context?.scale ?? null, count, mean: count ? total / count : null,
    distribution: counts.map((value, index) => ({ value: index + 1, count: value })), sourcePosition };
};
const rated = (scope: WorkScope, contexts: RatingContext[], counts: number[]): Loaded<RatingRead> =>
  ok({ contexts, context: contexts[0] ?? null, summary: summary(scope, contexts[0] ?? null, counts) });

export const globalRatings = rated(globalScope, [globalQuestion,
  question(iri('d2f4b6a8-0c1e-4a3b-9d5f-7b9d1f3b5d7f'), 'Would you recommend it to a first-time reader?', 5)],
[23, 61, 190, 432, 581]);
export const realmRatings = rated(realmScope, [question(iri('e3a5c7e9-1d2f-4b4c-8e6a-8c0e2a4c6e8a'),
  'How well does it fit Tidewater Readers?', 10)], [0, 1, 0, 2, 3, 5, 9, 14, 8, 6]);
export const mineRating = rated(mineScope, [globalQuestion], [0, 0, 0, 1, 0]);
export const noGlobalRatings = rated(globalScope, [globalQuestion], [0, 0, 0, 0, 0]);
export const noRealmRatings = rated(realmScope, [question(iri('e3a5c7e9-1d2f-4b4c-8e6a-8c0e2a4c6e8a'),
  'How well does it fit Tidewater Readers?', 10)], Array.from({ length: 10 }, () => 0));
export const noQuestion = rated(globalScope, [], []);

let senses = 0;
const chip = (value: string, source: 'local' | 'global', language = 'en') => ({
  sense: iri(`0d5e6f70-8192-4a3b-8c4d-${(++senses).toString().padStart(12, '0')}`),
  concept: iri('a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'), name: name(value, language), relevance: null, source,
  decision: iri('b1c2d3e4-f5a6-4b7c-9d8e-0f1a2b3c4d5e') });
export const globalClassifications = ok<ClassificationPage>({ ...page([chip('Adventure', 'global'),
  chip('Maritime fiction', 'global'), chip('Coming of age', 'global'), chip('Maps and cartography', 'global'),
  chip('海洋', 'global', 'zh-Hans')]), scope: { kind: 'global', realm: null } });
export const realmClassifications = ok<ClassificationPage>({ ...page([chip('Estuary cycle', 'local'),
  chip('Book club pick 2026', 'local'), chip('Adventure', 'global'), chip('Maritime fiction', 'global')]),
scope: { kind: 'realm', realm: iri(realmA) } });
export const noClassifications = ok<ClassificationPage>({ ...page([]), scope: { kind: 'global', realm: null } });

export const versions = ok<VersionPage>(page([
  { id: iri('11a3c5e7-9b0d-4f2a-8c4e-6a8c0e2a4c61'), kind: 'text-variant', language: 'en',
    contribution: iri('11a3c5e7-9b0d-4f2a-8c4e-6a8c0e2a4c61'), revision: iri('21b4d6f8-0a1c-4e3b-9d5f-7b9d1f3b5d72'),
    selected: true },
  { id: iri('31c5e7a9-1b2d-4f4c-8e6a-8c0e2a4c6e83'), kind: 'text-variant', language: 'ja',
    contribution: iri('31c5e7a9-1b2d-4f4c-8e6a-8c0e2a4c6e83'), revision: iri('41d6f8b0-2c3e-4a5d-9f7b-9d1f3b5d7f94'),
    selected: false },
  { id: iri('51e7a9c1-3d4f-4b6e-8a8c-0e2a4c6e8a05'), kind: 'text-variant', language: 'zh-Hans',
    contribution: iri('51e7a9c1-3d4f-4b6e-8a8c-0e2a4c6e8a05'), revision: iri('61f8b0d2-4e5a-4c7f-9b9d-1f3b5d7f9b16'),
    selected: false },
  { id: iri('71a9c1e3-5f6b-4d8a-8c0e-2a4c6e8a0c27'), kind: 'release', language: 'en',
    contribution: iri('11a3c5e7-9b0d-4f2a-8c4e-6a8c0e2a4c61'), revision: iri('81b0d2f4-6a7c-4e9b-9d1f-3b5d7f9b1d38'),
    selected: false },
], 'next-page-cursor'));
export const noVersions = ok<VersionPage>(page([]));

export const history = ok<HistoryPage>(page([
  { revision: work.revision, sequence: '4812', dataEpoch: sourcePosition.dataEpoch, current: true,
    href: `/v1/revisions/${work.revision.slice(-36)}` },
  { revision: iri('c5e7a9c1-3d4f-4b6e-8a8c-0e2a4c6e8a0c'), sequence: '3977', dataEpoch: sourcePosition.dataEpoch,
    current: false, href: '/v1/revisions/c5e7a9c1-3d4f-4b6e-8a8c-0e2a4c6e8a0c' },
  { revision: iri('f9b1d3f5-7a8c-4e0b-9d2f-4b6d8f0b2d4f'), sequence: '1203', dataEpoch: sourcePosition.dataEpoch,
    current: false, href: '/v1/revisions/f9b1d3f5-7a8c-4e0b-9d2f-4b6d8f0b2d4f' },
]));
