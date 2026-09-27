// Typed Main responses for the Work page's stories. Shapes come from the Eden
// types, so a contract change breaks the stories' build as well as the page's.
import type { WorkScope } from './route.ts';
import type { ScopeRealm, ScopeView } from './scope-bar.tsx';
import type { AdoptionPage, AgentCreditPage, AgentWorksPage, ChapterRead, ClassificationPage, ContentsPage, CreditPage,
  DiscussionPage, HistoryPage, Loaded, Progress, RatingContext, RatingRead, VersionPage, WorkHeader,
  WorkName } from './types.ts';

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
  types: ['https://schema.org/Book'], disclosure: 'public',
  originalTitle: { value: 'La Cartographe des marées', language: 'fr', direction: 'ltr' },
  metadataRevision: iri('a7c9e1b3-5d6f-4a8b-9c0d-2e4f6a8b0c1d'),
  description: { value: 'A surveyor maps a delta that redraws itself with every tide.\nWhat she records, the river '
    + 'undoes, until the map and the city begin to argue about which of them is true.', language: 'en',
  direction: 'ltr', basis: 'requested' },
  tagline: name('A novel of rivers, maps and the stories a city tells about itself.'),
  completionStatus: 'completed', chapterCount: 24, wordCount: 86_400, lastUpdatedAt: '2026-09-20T08:00:00.000Z',
  mainVersionRevision: iri('d3f5b7a9-1c2e-4d4f-8a6b-9c1e3f5a7b9d'), mainVersionLabel: null, selectedLanguage: 'en',
  sourcePosition, links: { versions: '', classifications: '', adoptions: '', ratings: '', history: '', credits: '',
    metadata: '', editions: '' },
};

/** A Work recorded without text: private to its creator so far, no types, no cover. */
export const metadataOnlyWork: WorkHeader = { ...work, title: name('Untitled field notes'), types: [], tagline: null,
  completionStatus: null, chapterCount: null, wordCount: null,
  disclosure: 'restricted', selectedLanguage: null, originalTitle: null, description: null, metadataRevision: null,
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
export const agentCredits = ok<AgentCreditPage>(page([
  { id: iri('f2b4d6f8-0a1c-4e3a-8b5d-7f9b1d3f5a71'), role: 'author', agent: iri('e1a3c5e7-9b0d-4f2a-8c4e-6a8c0e2a4c61'),
    displayName: 'Maren Osei', handle: 'maren' },
  { id: iri('f3c5e7a9-1b2d-4f4c-8e6a-8c0e2a4c6e82'), role: 'translator', agent: iri('e2b4d6f8-0a1c-4e3b-9d5f-7b9d1f3b5d72'),
    displayName: '林晓', handle: 'linxiao' },
]));
export const noAgentCredits = ok<AgentCreditPage>(page([]));

const credited = (uuid: string, title: string, key: string) => ({ id: iri(uuid), title: name(title),
  cover: { kind: 'fallback' as const, policy: 'avatar-fallback-v1', key, resourceType: 'work' },
  attribution: [{ credit: iri('f2b4d6f8-0a1c-4e3a-8b5d-7f9b1d3f5a71'), role: 'author' as const }] });
/** Other Works Maren Osei is credited on, with this one among them as Main lists it. */
export const agentWorks = ok<AgentWorksPage>(page([
  credited(workRef, 'The Cartographer of Tides', '3fa2c9d17b8e4a6f0c2d5e8b1a4f7c90'),
  credited('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', 'The Salt Road', 'salt-road'),
  credited('1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e', 'Lanterns over the Estuary', 'lanterns'),
  credited('2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f', 'A Grammar of Floods', 'floods'),
]));

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
type Level = 'central' | 'substantial' | 'incidental';
const chip = (value: string, source: 'local' | 'global', language = 'en', level: Level | null = null) => ({
  sense: iri(`0d5e6f70-8192-4a3b-8c4d-${(++senses).toString().padStart(12, '0')}`),
  concept: iri('a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d'), name: name(value, language), source,
  relevanceRevision: level ? iri('c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f') : null,
  relevanceStatus: level ? 'recorded' as const : 'unrecorded' as const,
  relevance: level ? { level, policy: 'work-editor-topical-relevance-v1' as const,
    basis: 'work-editor-assessment' as const, revision: iri('c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f') } : null,
  decision: iri('b1c2d3e4-f5a6-4b7c-9d8e-0f1a2b3c4d5e') });
export const globalClassifications = ok<ClassificationPage>({ ...page([chip('Adventure', 'global', 'en', 'substantial'),
  chip('Maritime fiction', 'global', 'en', 'central'), chip('Coming of age', 'global', 'en', 'incidental'),
  chip('Maps and cartography', 'global'), chip('海洋', 'global', 'zh-Hans')]), scope: { kind: 'global', realm: null } });
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
  { id: iri('b7d9f1a3-5c6e-4a8b-9c0d-2e4f6a8b0c19'), kind: 'reply-placement', sequence: '4812',
    dataEpoch: sourcePosition.dataEpoch, href: null },
  { id: work.revision, kind: 'metadata-revision', sequence: '4790', dataEpoch: sourcePosition.dataEpoch,
    href: `/v1/revisions/${work.revision.slice(-36)}` },
  { id: iri('c8e0a2b4-6d7f-4b9c-8d1e-3f5a7b9c1d28'), kind: 'publication-decision', sequence: '3977',
    dataEpoch: sourcePosition.dataEpoch, href: null },
  { id: iri('f9b1d3f5-7a8c-4e0b-9d2f-4b6d8f0b2d4f'), kind: 'metadata-revision', sequence: '1203',
    dataEpoch: sourcePosition.dataEpoch, href: '/v1/revisions/f9b1d3f5-7a8c-4e0b-9d2f-4b6d8f0b2d4f' },
], 'history-next-cursor'));
export const noHistory = ok<HistoryPage>(page([]));

const reply = (n: number, realm: string, body: string, sequence: string) => ({
  reply: iri(`d0e1f2a3-b4c5-4d6e-8f7a-${n.toString().padStart(12, '0')}`), realm: iri(realm),
  placement: iri(`e1f2a3b4-c5d6-4e7f-8a9b-${n.toString().padStart(12, '0')}`),
  revisionId: `f2a3b4c5-d6e7-4f8a-9b0c-${n.toString().padStart(12, '0')}`, body, dataEpoch: sourcePosition.dataEpoch,
  sequence });
export const discussion = ok<DiscussionPage>(page([
  reply(1, realmA, 'The chapter where the map floods is the best thing I have read this year.\nThe prose slows down '
    + 'exactly when the water rises.', '4812'),
  reply(2, realmB, '第三章把测绘写成了一种祈祷，读完很久都放不下。', '4650'),
  reply(3, realmA, 'Does anyone else read the cartographer as unreliable? Every measurement is dated but never signed.',
    '4402'),
], 'discussion-next-cursor'));
export const noDiscussion = ok<DiscussionPage>(page([]));

const structure = iri('a4b6c8d0-e2f4-4a6b-8c0d-2e4f6a8b0c11');
const occurrence = (n: number) => iri(`b5c7d9e1-f3a5-4b7c-9d1e-${n.toString().padStart(12, '0')}`);
const contentRevision = (n: number) => `urn:rezics:content:revision:c6d8e0f2-a4b6-4c8d-9e0f-${n.toString().padStart(12, '0')}` as const;
const entry = (n: number, role: 'group' | 'chapter', label: string | null, available = true) => ({
  occurrence: occurrence(n), parent: structure, role, label: label ? { value: label, language: 'en' } : null,
  target: role === 'chapter' ? iri(`d7e9f1a3-b5c7-4d9e-8f1a-${n.toString().padStart(12, '0')}`) : null,
  selectedRevision: role === 'chapter' && available ? contentRevision(n) : null,
  progress: role === 'chapter' && available ? { composition: structure, occurrence: occurrence(n),
    selectedRevision: contentRevision(n) } : null,
  availability: role === 'group' || available ? 'available' as const : 'unavailable' as const });
const contentsPage = (items: ContentsPage['items'], nextCursor: string | null = null): ContentsPage => ({
  profile: 'work-contents-v1', work: workId, version: mainVersion, composition: structure,
  compositionRevision: iri('e8f0a2b4-c6d8-4e0f-9a1b-3c5d7e9f1a2b'), language: 'en', ...page(items, nextCursor) });
export const contents = ok(contentsPage([entry(1, 'group', 'Part One: The Delta'), entry(2, 'chapter', 'Low Water'),
  entry(3, 'chapter', 'The Surveyor’s Chain'), entry(4, 'chapter', null), entry(5, 'chapter', 'Neap Tide', false)],
'contents-next-cursor'));
export const noContents: Loaded<ContentsPage> = { ok: false, failure: 'missing' };

const chapterText = ['The tide went out at four and took the eastern bank with it.',
  'Maren had learned not to trust anything the river left behind: sandbars that looked like streets, streets '
    + 'that were only low water with ambitions.',
  'She set the chain across the mud, counted the links aloud, and wrote the number in the ledger before the sea '
    + 'could argue.',
  'By evening the ledger disagreed with the city again. It always did. The city was wrong more often than the '
    + 'ledger, but the city was where people lived.'].join('\n');
export const chapter: ChapterRead = { profile: 'work-chapter-v1', work: workId, version: mainVersion,
  composition: structure, compositionRevision: iri('e8f0a2b4-c6d8-4e0f-9a1b-3c5d7e9f1a2b'), occurrence: occurrence(3),
  parent: structure, parentPath: [], ordinal: 2, label: { value: 'The Surveyor’s Chain', language: 'en' },
  language: 'en', selectedRevision: contentRevision(3),
  progress: { composition: structure, occurrence: occurrence(3), selectedRevision: contentRevision(3) },
  previous: occurrence(2), next: occurrence(4), sourcePosition,
  content: { reference: { owner: 'content', resourceId: iri('d7e9f1a3-b5c7-4d9e-8f1a-000000000003'),
    variantId: 'urn:rezics:variant:0f1e2d3c-4b5a-4968-8776-655443322110',
    revisionId: 'c6d8e0f2-a4b6-4c8d-9e0f-000000000003', format: 'rezics-content-json-v1', model: 'content-text-v1',
    byteDigest: 'a'.repeat(64), byteLength: chapterText.length, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
    direction: 'ltr', sourceRevision: null, predecessor: null, provenance: {} },
  serializedJson: JSON.stringify({ body: chapterText }), body: { body: chapterText } } };
const cjkText = ['潮水在四点退去，把东岸也一并带走了。', '她学会了不去相信河流留下的任何东西：像街道的沙洲，和只是怀着野心的浅水的街道。',
  '她把测链铺过泥滩，大声数着链环，在海水反驳之前把数字写进账簿。'].join('\n');
export const cjkChapter: ChapterRead = { ...chapter, language: 'zh-Hans', previous: null,
  label: { value: '测量员的链条', language: 'zh-Hans' },
  content: { ...chapter.content, reference: { ...chapter.content.reference,
    language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-Hans' } },
  serializedJson: JSON.stringify({ body: cjkText }), body: { body: cjkText } } };
export const lastChapter: ChapterRead = { ...chapter, next: null };

const openProgress: Progress = { structure, occurrence: occurrence(3), selectedRevision: contentRevision(3),
  completed: false, position: 'p:2', version: 3 };
export const progress = ok(openProgress);
export const completedProgress = ok<Progress>({ ...openProgress, completed: true });
