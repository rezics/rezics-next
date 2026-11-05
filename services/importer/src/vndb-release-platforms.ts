import { bundledDigest } from '@rezics/definitions/bundled';
import { mapSourceEnumeration } from '@rezics/conversion/cross-media-entities';
import {
  sourceVocabularyLimits,
  type NativeIdentity,
  type VndbVocabularyRow,
} from '@rezics/conversion/source-vocabulary';
import {
  vndbReleaseMediumCodes,
  vndbReleaseMediumTaxonomy,
  vndbReleasePlatformTaxonomy,
} from '../../../packages/conversion/src/support.ts';
import type { CrossMediaGap, CrossMediaTables } from './cross-media-seed.ts';

type Row = Record<string, unknown>;
export type VndbReleaseAssociation = Readonly<{ code: string; path: string }>;
export type VndbReleasePlatformFacts = Readonly<{
  platforms: readonly VndbReleaseAssociation[];
  media: readonly VndbReleaseAssociation[];
}>;
export type VndbReleasePlatformPlan = Readonly<{
  byRelease: ReadonlyMap<string, VndbReleasePlatformFacts>;
  gaps: readonly CrossMediaGap[];
}>;

const RELEASE_ID = /^r[1-9][0-9]*$/u;
const CODE = /^[a-z][a-z0-9]{0,15}$/u;
export const vndbReleaseAssociationReleaseCap = 64;
const RELEASE_CAP = vndbReleaseAssociationReleaseCap;
const ASSOCIATION_CAP = sourceVocabularyLimits.rows;
const SOURCE_ROW_CAP = RELEASE_CAP * ASSOCIATION_CAP;
const GAP_CAP = sourceVocabularyLimits.gaps;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}

function compareGap(left: CrossMediaGap, right: CrossMediaGap): number {
  const leftRecord = JSON.stringify(
    Object.fromEntries(Object.entries(left.record).sort(([a], [b]) => compareText(a, b))),
  );
  const rightRecord = JSON.stringify(
    Object.fromEntries(Object.entries(right.record).sort(([a], [b]) => compareText(a, b))),
  );
  return (
    compareText(left.fields.join('\0'), right.fields.join('\0')) ||
    compareText(leftRecord, rightRecord) ||
    compareText(left.reason, right.reason)
  );
}

function codeGapRecord(id: unknown, field: 'platform' | 'medium', code: unknown): Row {
  const record: Row = {};
  if (typeof id === 'string' && id.length <= 64) record.id = id;
  if (typeof code === 'string' && code.length <= 64) record[field] = code;
  else if (code === null) record[field] = null;
  return record;
}

/** Read only associations for already selected release keys; lists remain independent and duplicate rows collapse. */
export async function planVndbReleasePlatforms(
  tables: CrossMediaTables,
  releaseKeys: readonly string[],
  availableRows: ReadonlyMap<string, number> = new Map(),
): Promise<VndbReleasePlatformPlan> {
  if (releaseKeys.length > RELEASE_CAP || releaseKeys.some((id) => !RELEASE_ID.test(id)))
    throw new TypeError('Invalid selected VNDB release keys');
  const selected = new Set([...new Set(releaseKeys)].sort(compareText));
  const mutable = new Map<
    string,
    { platforms: Map<string, VndbReleaseAssociation>; media: Map<string, VndbReleaseAssociation> }
  >();
  for (const id of selected) mutable.set(id, { platforms: new Map(), media: new Map() });
  const gaps: CrossMediaGap[] = [];
  const seenAssociations = new Set<string>();
  let selectedRows = 0;
  const gap = (table: string, record: Row, reason: string) => {
    const candidate: CrossMediaGap = { source: 'vndb', fields: fieldsOf(table, record), record, reason };
    if (gaps.some((item) => compareGap(item, candidate) === 0)) return;
    if (gaps.length < GAP_CAP) gaps.push(candidate);
    else {
      let last = 0;
      for (let index = 1; index < gaps.length; index += 1) if (compareGap(gaps[last]!, gaps[index]!) < 0) last = index;
      if (compareGap(candidate, gaps[last]!) < 0) gaps[last] = candidate;
    }
  };

  for (const [table, field, list] of [
    ['releases_platforms', 'platform', 'platforms'],
    ['releases_media', 'medium', 'media'],
  ] as const) {
    for await (const row of tables.rows('vndb', table)) {
      const id = row.id;
      if (typeof id !== 'string' || !selected.has(id)) continue;
      const safe = codeGapRecord(id, field, row[field]);
      const code = row[field];
      if (typeof code !== 'string' || code.length > 64 || !code.isWellFormed() || !CODE.test(code)) {
        gap(table, safe, `Invalid VNDB release ${field} code`);
        continue;
      }
      const allowed =
        field === 'platform'
          ? (() => {
              const mapping = mapSourceEnumeration('vndb', 'platform', code);
              return mapping?.term === 'schema:gamePlatform';
            })()
          : vndbReleaseMediumCodes.has(code);
      if (!allowed) {
        gap(table, safe, `Unsupported VNDB release ${field} code`);
        continue;
      }
      const rowFacts = mutable.get(id)!;
      const listFacts = rowFacts[list];
      const associationKey = `${id}\0${list}\0${code}`;
      if (seenAssociations.has(associationKey)) continue;
      seenAssociations.add(associationKey);
      const associationCount = rowFacts.platforms.size + rowFacts.media.size;
      const associationCap = Math.min(ASSOCIATION_CAP, availableRows.get(id) ?? ASSOCIATION_CAP);
      if (associationCount >= associationCap) {
        gap(table, safe, 'Release platform and medium associations exceed the available source-vocabulary row cap');
        continue;
      }
      if (selectedRows >= SOURCE_ROW_CAP) {
        gap(table, safe, 'Release platform and medium associations exceed the bounded import cap');
        continue;
      }
      selectedRows += 1;
      listFacts.set(code, { code, path: `/${table}/${id}/${field}` });
    }
  }

  const byRelease = new Map<string, VndbReleasePlatformFacts>();
  for (const [id, rows] of mutable) {
    byRelease.set(id, {
      platforms: [...rows.platforms.values()].sort((left, right) => compareText(left.code, right.code)),
      media: [...rows.media.values()].sort((left, right) => compareText(left.code, right.code)),
    });
  }
  gaps.sort(compareGap);
  return { byRelease, gaps };
}

export function vndbReleasePlatformPayload(id: string, facts: VndbReleasePlatformFacts): Row {
  return {
    releases_platforms: facts.platforms.map(({ code }) => ({ id, platform: code })),
    releases_media: facts.media.map(({ code }) => ({ id, medium: code })),
  };
}

export function vndbReleasePlatformVocabulary(
  owner: { external_id: string },
  subject: string,
  byRelease: ReadonlyMap<string, VndbReleasePlatformFacts>,
): VndbVocabularyRow[] {
  if (!RELEASE_ID.test(owner.external_id)) return [];
  const facts = byRelease.get(owner.external_id);
  if (!facts) return [];
  const release: NativeIdentity = { id: subject, type: 'wd:Q20631656', releaseDigest: bundledDigest };
  return [
    ...facts.platforms.map(({ code, path }): VndbVocabularyRow => ({ kind: 'release-platform', path, release, code })),
    ...facts.media.map(({ code, path }): VndbVocabularyRow => ({ kind: 'release-medium', path, release, code })),
  ];
}

export function vndbReleaseClassificationTaxonomies(): readonly string[] {
  return [vndbReleasePlatformTaxonomy, vndbReleaseMediumTaxonomy];
}
