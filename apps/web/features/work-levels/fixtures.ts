import { direction } from '@rezics/main/language';
import type { Loaded, Part, PartsPage, RealizationPage, Realization, RelationEntry, RelationsPage, Release, ReleasePage,
  Summary, WholesPage } from './types.ts';

// Story and test fixtures in Main's response shapes. The relation labels are the
// ones Main's bootstrap lexicon carries; nothing in the feature reads them from here.

export const iri = (tail: string) => `https://rezics.com/id/01944100-0000-7000-8000-${tail.padStart(12, '0')}`;
export const workRef = 'index-new-testament';
export const current = iri('100').slice(-36);
const position = { datasetId: 'product' as const, dataEpoch: 'epoch', sequence: '1' };

export function summary(reference: string, name: string, language = 'en', type: 'work' | 'collection' | 'main-version' | 'resource' = 'work'): Summary {
  return { reference, status: 'available', type, base: type === 'work' ? 'work' : 'resource', work: null, disclosure: 'public',
    name: { value: name, language, direction: direction(language, name), basis: 'requested' },
    avatar: { kind: 'fallback', policy: 'fallback-avatar-v1', key: reference, resourceType: type } } as unknown as Summary;
}

export const names = new Map<string, Summary>([
  [iri('101'), summary(iri('101'), 'A Certain Magical Index NT 1')], [iri('102'), summary(iri('102'), 'A Certain Magical Index NT 22')],
  [iri('103'), summary(iri('103'), 'A Certain Magical Index NT 22 Reverse')],
  [iri('100'), summary(iri('100'), 'A Certain Magical Index: New Testament')],
  [iri('200'), summary(iri('200'), 'A Certain Magical Index', 'en')],
  [iri('300'), summary(iri('300'), 'とある魔術の禁書目録', 'ja')],
  [iri('301'), summary(iri('301'), 'とある科学の超電磁砲', 'ja')],
  [iri('302'), summary(iri('302'), 'مكتبة الأدب', 'ar')],
]);

const part = (n: number, label: string, work: string, extra: Partial<Part> = {}): Part => ({ occurrence: iri(`5${n}`), role: 'part',
  parent: iri('9'), segmentKey: `s${n}`, orderKey: `o${n}`, labels: [], work, mainVersion: iri(`6${n}`), displayLabel: label,
  inclusion: 'required', ...extra });

export const parts: Loaded<PartsPage> = { ok: true, data: { resource: iri('100'), mainVersion: iri('7'), structure: iri('9'),
  revision: iri('8'), completion: { status: 'concluded', evidence: ['https://example.com/index-nt/completed'] },
  parts: [part(1, '1', iri('101')), part(2, '22', iri('102')), part(3, '22 Reverse', iri('103')),
    part(4, 'SS1', iri('301'), { inclusion: 'extra' }), part(5, '', iri('302'), { displayLabel: undefined, labels: [{ value: 'مقدمة', language: 'ar' }],
      inclusion: 'optional' })],
  next: null, sourcePosition: position } };

export const pagedParts: Loaded<PartsPage> = { ok: true, data: { ...parts.ok ? parts.data : {} as PartsPage, next: 'cursor-2' } };

export const wholes: Loaded<WholesPage> = { ok: true, data: { resource: iri('100'), wholes: [{ occurrence: iri('41'),
  mainVersion: iri('42'), work: iri('200'), structure: iri('43'), segmentKey: 's', orderKey: 'o' }],
next: null, sourcePosition: position } };

/** A rendering in the shape Main answers: the label for one viewing direction, its counterparts, its fallback. */
function rendering(input: { definition: string; viewingRole: string; toRole: string; label: { one: string; other: string };
  language?: string; counterparts: string[]; fallback?: string }): NonNullable<RelationEntry['rendering']> {
  const language = input.language ?? 'en';
  return { profile: 'relation-rendering-v1', meaning: { definition: iri(input.definition), revision: iri(`${input.definition}1`),
    lifecycle: 'active', roles: [{ role: iri('r1'), key: input.viewingRole, minParticipants: 1, maxParticipants: 1, ordered: false },
      { role: iri('r2'), key: input.toRole, minParticipants: 1, maxParticipants: 1, ordered: false }] },
  occurrence: null, viewingRole: input.viewingRole, bindings: [],
  projections: [{ fromRole: input.viewingRole, toRole: input.toRole, presentation: null,
    labels: { noun: input.label.one, heading: input.label.other, plurals: { one: input.label.one, other: input.label.other },
      grammaticalForms: [] }, language, script: null, direction: direction(language, input.label.one), reviewStatus: 'draft', source: null,
    licence: null, fallback: input.fallback ? { reason: 'language-fallback', requestedLanguages: ['de'], usedLanguage: input.fallback,
      requestedScript: null, usedScript: null, crossedScript: false, conversion: null } : null,
    arguments: input.counterparts.map(ref => ({ role: input.toRole, type: 'resource', value: { kind: 'resource', ref } })) }] } as NonNullable<RelationEntry['rendering']>;
}

const entry = (relation: string, kind: RelationEntry['kind'], counterparts: Summary[], rendered: NonNullable<RelationEntry['rendering']> | null,
  extra: Partial<RelationEntry> = {}): RelationEntry => ({ relation: iri(relation), kind, revision: iri(`${relation}1`), evidence: 'https://example.com/evidence',
  rendering: rendered, counterparts, ...extra } as RelationEntry);

export const relationEntries: RelationEntry[] = [
  entry('a1', 'collection', [summary(iri('900'), 'A Certain Magical Index franchise', 'en', 'collection')], null),
  entry('a2', 'derivation', [names.get(iri('300'))!], rendering({ definition: 'd1', viewingRole: 'reboot', toRole: 'source',
    label: { one: 'Reboot of', other: 'Reboots of' }, counterparts: [iri('300')] }), { sourceVersionStatus: 'unresolved' }),
  entry('a3', 'derivation', [names.get(iri('301'))!, names.get(iri('302'))!], rendering({ definition: 'd2', viewingRole: 'source', toRole: 'spin-off',
    label: { one: 'Spin-off', other: 'Spin-offs' }, counterparts: [iri('301'), iri('302')] }), { sourceVersionStatus: 'exact' }),
  entry('a4', 'occurrence', [names.get(iri('200'))!], rendering({ definition: 'd3', viewingRole: 'sequel', toRole: 'predecessor',
    label: { one: '続編元', other: '続編元' }, language: 'ja', counterparts: [iri('200')], fallback: 'ja' })),
];

export const relations: Loaded<RelationsPage> = { ok: true, data: { profile: 'resource-relations-v1', resource: iri('100'),
  items: relationEntries, next: null, sourcePosition: position } };

const realization = (n: string, language: string, extra: Partial<Realization> = {}): Realization => ({ profile: 'realization-v1', id: iri(n),
  language, kind: 'translation', translators: [iri('a1')], publishers: [iri('a2')], status: 'official', verification: 'verified',
  evidence: 'https://example.com/evidence', work: iri('100'), revision: iri(`${n}1`),
  source: { kind: 'main-version', work: iri('100'), mainVersion: iri('7'), revision: iri('8') }, ...extra } as Realization);

export const realizations: Loaded<RealizationPage> = { ok: true, data: { items: [
  realization('r1', 'ja', { kind: 'original', translators: [], status: 'official' }),
  realization('r2', 'zh-Hant', { source: { kind: 'realization', work: iri('100'), realization: iri('r1'), revision: iri('r11') } }),
  realization('r3', 'zh-Hans', { status: 'unofficial', verification: 'unverified', evidence: null,
    source: { kind: 'unresolved', work: iri('100') } }),
], nextCursor: null, sourcePosition: position, count: { value: 3, kind: 'exact-page', total: null } } };

export const translators = new Map<string, Summary>([
  [iri('a1'), summary(iri('a1'), 'Lin Mei', 'en', 'resource')], [iri('a2'), summary(iri('a2'), '台灣角川', 'zh-Hant', 'resource')]]);

const release = (n: string, extra: Partial<Release>): Release => ({ profile: 'release-v2', id: iri(n), revision: iri(`${n}1`), kind: 'formal',
  status: 'official', contentLanguages: ['en'], isTranslation: true, originalLanguages: ['ja'], titleLanguage: 'en',
  tracklistLanguage: null, title: { value: 'A Certain Magical Index, Vol. 1', language: 'en' }, isbn13: null, editionStatement: null,
  publisher: 'Yen Press', publicationYear: 2014, originalUrl: null, fixedRelease: null, identifiers: [], platform: null,
  territory: null, coverage: [{ realization: iri('r2'), revision: iri('r21'), work: iri('101'), mainVersion: iri('61'), language: 'en',
    completeness: 'complete' }], legacyCoverage: null, snapshots: [], ...extra } as Release);

export const releases: Loaded<ReleasePage> = { ok: true, data: { items: [
  release('c1', { isbn13: '9780316371247', territory: 'US', platform: 'Paperback' }),
  release('c2', { title: { value: 'とある魔術の禁書目録 1〜3 合本', language: 'ja' }, contentLanguages: ['ja'], isTranslation: false,
    originalLanguages: [], publisher: '電撃文庫', publicationYear: 2019, identifiers: [{ provider: 'asin', value: 'B07XYZ1234' }],
    coverage: ['101', '102', '103'].map(work => ({ realization: iri('r1'), revision: iri('r11'), work: iri(work), mainVersion: iri(`6${work}`),
      language: 'ja', completeness: 'complete' as const })) }),
  release('c3', { kind: 'web', status: 'withdrawn', title: { value: '星港夜話', language: 'zh' }, contentLanguages: ['zh'], isTranslation: false,
    originalLanguages: [], publisher: null, publicationYear: null, originalUrl: 'https://example.com/star-harbor',
    coverage: [{ realization: null, revision: null, work: iri('102'), mainVersion: iri('62'), language: null, completeness: 'partial', portion: 'chapters 1-20' }],
    snapshots: [{ id: iri('s1'), fetchedAt: '2024-03-01T00:00:00.000Z', byteDigest: 'a'.repeat(64), byteLength: 12,
      coverage: { scope: 'chapters 1-20', complete: false }, acquisition: 'fixture' }] }),
], nextCursor: null, sourcePosition: position, count: { value: 3, kind: 'exact-page', total: null } } };
