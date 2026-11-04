import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceRecord } from '@rezics/conversion';
import {
  sourceVocabularyLimits,
  type NativeIdentity,
  type SourceVocabularyBindings,
  type SourceVocabularyRequest,
} from '@rezics/conversion/source-vocabulary';
import { converter_revision as entityRevision, vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { Owner } from './record-bindings.ts';
import { type GraphEdgeDraft } from './cross-media-bindings.ts';
import {
  CrossMediaTableScanLimitError,
  collectSelectedReleaseTitles,
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaGap,
  type CrossMediaMember,
  type CrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaReading,
  type CrossMediaSeedResult,
  type CrossMediaTableScanLimits,
  type CrossMediaTables,
} from './cross-media-seed.ts';
import type { ImporterOptions } from './importer.ts';
import {
  planVndbReleasePlatforms,
  vndbReleaseClassificationTaxonomies,
  vndbReleasePlatformPayload,
  vndbReleasePlatformVocabulary,
  type VndbReleasePlatformFacts,
} from './vndb-release-platforms.ts';
import {
  vndbReleaseMediumSchemeUri,
  vndbReleaseMediumTaxonomy,
  vndbReleasePlatformSchemeUri,
  vndbReleasePlatformTaxonomy,
} from '../../../packages/conversion/src/support.ts';

export const developmentStatusSchemeUri = 'https://vndb.org/development-status';
export const developmentStatusTaxonomy = 'vndb.development-status';
export const releasedStateSchemeUri = 'https://vndb.org/releases/released';
export const releasedStateTaxonomy = 'vndb.releases.released';
export const developmentStatusConceptUri = (code: string) => `${developmentStatusSchemeUri}/${code}`;
export const releasedStateConceptUri = (code: string) => `${releasedStateSchemeUri}/${code}`;

type Row = Record<string, unknown>;
const RELEASE_CAP = 64;
const RELEASE_DEPTH_CAP = 8;
const RELEASE_WORK_ENDPOINT_CAP = 64;
const RELEASE_MEMBERSHIP_CAP = 512;
const RELEASE_GAP_CAP = 128;
export const vndbWorkIdentity = /^v[1-9][0-9]*$/;
export const vndbReleaseIdentity = /^r[1-9][0-9]*$/;
const WORK_ID = vndbWorkIdentity;
const RELEASE_ID = vndbReleaseIdentity;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const RELEASE_SCAN_LIMITS: Readonly<Record<string, { maxRows: number; maxBytes: number }>> = Object.freeze({
  vn: { maxRows: 100_000, maxBytes: 64 * 1024 * 1024 },
  vn_titles: { maxRows: 500_000, maxBytes: 128 * 1024 * 1024 },
  entry_meta: { maxRows: 100_000, maxBytes: 64 * 1024 * 1024 },
  releases_vn: { maxRows: 500_000, maxBytes: 64 * 1024 * 1024 },
  releases: { maxRows: 100_000, maxBytes: 64 * 1024 * 1024 },
  releases_titles: { maxRows: 500_000, maxBytes: 128 * 1024 * 1024 },
  releases_supersedes: { maxRows: 100_000, maxBytes: 16 * 1024 * 1024 },
  releases_platforms: { maxRows: 500_000, maxBytes: 64 * 1024 * 1024 },
  releases_media: { maxRows: 500_000, maxBytes: 64 * 1024 * 1024 },
});

async function* boundedRows(input: CrossMediaTables, table: string): AsyncGenerator<Row> {
  const limit = RELEASE_SCAN_LIMITS[table];
  ensure(limit, `Missing VNDB release scan budget: ${table}`);
  let rows = 0;
  let bytes = 0;
  const limits: CrossMediaTableScanLimits = {
    ...limit,
    consumeRow(size) {
      if (rows >= limit.maxRows || bytes + size > limit.maxBytes)
        throw new CrossMediaTableScanLimitError('vndb', table);
      rows += 1;
      bytes += size;
    },
  };
  let accountedRows = 0;
  for await (const row of input.rows('vndb', table, limits)) {
    if (rows === accountedRows) {
      limits.consumeRow!(Buffer.byteLength(JSON.stringify(row), 'utf8') + 1);
    }
    accountedRows = rows;
    yield row;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type VndbReleaseBindingGroup = {
  taxonomy: string;
  uri: string;
  schemeId: string;
  concepts: readonly { code: string; id: string }[];
};
export type VndbReleaseFacts = {
  works: Map<string, { devstatus: number | undefined }>;
  releases: Map<string, { released: unknown; links: { vid: string; completeness: string }[] }>;
};

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function text(row: Row, field: string): string {
  const value = row[field];
  ensure(typeof value === 'string' && value.length > 0, `Missing source field: ${field}`);
  return value;
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}

/** Dump integer YYYYMMDD, ISO day/month/year, TBA, unknown and COPY null stay distinct; components are never guessed. */
export function decodeVndbReleased(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0)
    return decodeVndbReleased(String(value).padStart(8, '0'));
  if (typeof value !== 'string') return String(value);
  if (value === 'TBA' || value === 'unknown') return value;
  if (value === '99999999' || value === '9999-99-99' || value === '9999-12-31') return 'TBA';
  if (value === '00000000' || value === '0000-00-00' || value === '0') return 'unknown';
  if (/^[0-9]{8}$/u.test(value)) {
    const year = value.slice(0, 4);
    const month = value.slice(4, 6);
    const day = value.slice(6, 8);
    if (year === '0000') return 'unknown';
    if (year === '9999') return 'TBA';
    if (month === '00' || month === '99') return year;
    if (day === '00' || day === '99') return `${year}-${month}`;
    return `${year}-${month}-${day}`;
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value) && value.startsWith('0000')) return 'unknown';
  return value;
}

export function decodeVndbDevstatus(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) return Number(value);
}

function adoptedContents(read: unknown, property: string): string[] {
  const statements = (read as { subject?: { statements?: Record<string, { value?: { content?: unknown } }[]> } })
    .subject?.statements?.[property];
  return (Array.isArray(statements) ? statements : []).flatMap((statement) =>
    typeof statement.value?.content === 'string' ? [statement.value.content] : [],
  );
}

/** Current disclosed/adopted development-status and released-state schemes. Retracted identities are withheld. */
export async function readVndbReleaseBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  groups: readonly VndbReleaseBindingGroup[],
): Promise<SourceVocabularyBindings> {
  const empty: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  if (!Array.isArray(groups) || groups.length > sourceVocabularyLimits.schemes) return empty;
  const allowedSchemes = new Map([
    [developmentStatusTaxonomy, developmentStatusSchemeUri],
    [releasedStateTaxonomy, releasedStateSchemeUri],
    [vndbReleasePlatformTaxonomy, vndbReleasePlatformSchemeUri],
    [vndbReleaseMediumTaxonomy, vndbReleaseMediumSchemeUri],
  ]);
  const readCache = new Map<string, Promise<unknown>>();
  const read = (id: string) => {
    let pending = readCache.get(id);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => port.readReviewedSubject(id))
        .catch(() => undefined);
      readCache.set(id, pending);
    }
    return pending;
  };
  const schemes: SourceVocabularyBindings['schemes'][number][] = [];
  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  let conceptCount = 0;
  const orderedGroups = groups
    .filter(
      (group) =>
        group &&
        typeof group.taxonomy === 'string' &&
        allowedSchemes.get(group.taxonomy) === group.uri &&
        typeof group.uri === 'string' &&
        typeof group.schemeId === 'string' &&
        Array.isArray(group.concepts),
    )
    .sort(
      (left, right) =>
        compareText(left.taxonomy, right.taxonomy) ||
        compareText(left.uri, right.uri) ||
        compareText(left.schemeId, right.schemeId),
    );
  for (const group of orderedGroups) {
    if (
      typeof group.taxonomy !== 'string' ||
      allowedSchemes.get(group.taxonomy) !== group.uri ||
      group.taxonomy.length > 64 ||
      typeof group.uri !== 'string' ||
      group.uri.length > 512 ||
      !UUID.test(group.schemeId) ||
      !Array.isArray(group.concepts)
    )
      continue;
    const schemeRead = await read(group.schemeId);
    const scheme = (schemeRead as { subject?: { id?: string; type?: string } } | undefined)?.subject;
    if (!scheme || scheme.id !== group.schemeId || scheme.type !== 'skos:ConceptScheme') continue;
    if (!adoptedContents(schemeRead, 'schema:url').includes(group.uri)) continue;
    schemes.push({
      taxonomy: group.taxonomy,
      id: group.schemeId,
      uri: group.uri,
      type: 'skos:ConceptScheme',
      releaseDigest: bundledDigest,
    });
    const conceptLimit = Math.min(group.concepts.length, sourceVocabularyLimits.concepts - conceptCount);
    const groupConcepts: VndbReleaseBindingGroup['concepts'] = group.concepts;
    const orderedConcepts = groupConcepts
      .slice(0, conceptLimit)
      .filter(
        (item): item is VndbReleaseBindingGroup['concepts'][number] =>
          !!item && typeof item.code === 'string' && typeof item.id === 'string',
      )
      .sort((left, right) => compareText(left.code, right.code) || compareText(left.id, right.id));
    conceptCount += conceptLimit;
    for (const item of orderedConcepts) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(item.code) || !UUID.test(item.id)) continue;
      const conceptRead = await read(item.id);
      const concept = (conceptRead as { subject?: { id?: string; type?: string } } | undefined)?.subject;
      if (!concept || concept.id !== item.id || concept.type !== 'skos:Concept') continue;
      if (!adoptedContents(conceptRead, 'schema:url').includes(`${group.uri}/${item.code}`)) continue;
      if (!adoptedContents(conceptRead, 'skos:inScheme').includes(group.schemeId)) continue;
      concepts.push({
        taxonomy: group.taxonomy,
        code: item.code,
        id: item.id,
        type: 'skos:Concept',
        schemeId: group.schemeId,
        releaseDigest: bundledDigest,
      });
    }
  }
  if (!schemes.length) return empty;
  const uniqueSchemes = new Map<string, (typeof schemes)[number]>();
  const conflictingSchemes = new Set<string>();
  for (const scheme of schemes) {
    const previous = uniqueSchemes.get(scheme.taxonomy);
    if (previous && (previous.id !== scheme.id || previous.uri !== scheme.uri)) conflictingSchemes.add(scheme.taxonomy);
    else uniqueSchemes.set(scheme.taxonomy, scheme);
  }
  const uniqueConcepts = new Map<string, (typeof concepts)[number]>();
  const conflictingConcepts = new Set<string>();
  for (const concept of concepts) {
    const key = `${concept.taxonomy}\0${concept.code}`;
    const previous = uniqueConcepts.get(key);
    if (previous && previous.id !== concept.id) conflictingConcepts.add(key);
    else uniqueConcepts.set(key, concept);
  }
  return {
    releaseDigest: bundledDigest,
    schemes: [...uniqueSchemes.values()].filter((scheme) => !conflictingSchemes.has(scheme.taxonomy)),
    concepts: [...uniqueConcepts.entries()]
      .filter(([key, concept]) => !conflictingConcepts.has(key) && !conflictingSchemes.has(concept.taxonomy))
      .map(([, concept]) => concept),
  };
}

export function vndbReleaseVocabulary(
  owner: Owner,
  subject: string,
  facts: VndbReleaseFacts,
  identities: Map<string, NativeIdentity>,
): SourceVocabularyRequest['rows'] {
  const rows: SourceVocabularyRequest['rows'][number][] = [];
  if (WORK_ID.test(owner.external_id)) {
    const work: NativeIdentity = { id: subject, type: 'wd:Q689445', releaseDigest: bundledDigest };
    identities.set(owner.external_id, work);
    const code = facts.works.get(owner.external_id)?.devstatus;
    if (code !== undefined)
      rows.push({ kind: 'development-status', path: `/vn/${owner.external_id}/devstatus`, subject: work, code });
    return rows;
  }
  if (!RELEASE_ID.test(owner.external_id)) return rows;
  const release: NativeIdentity = { id: subject, type: 'wd:Q20631656', releaseDigest: bundledDigest };
  identities.set(owner.external_id, release);
  const fact = facts.releases.get(owner.external_id);
  if (!fact) return rows;
  rows.push({
    kind: 'release-date',
    path: `/releases/${owner.external_id}/released`,
    release,
    value: decodeVndbReleased(fact.released),
  });
  for (const link of fact.links) {
    const work = identities.get(link.vid);
    rows.push({
      kind: 'release-work',
      path: `/releases_vn/${owner.external_id}/${link.vid}`,
      release,
      ...(work ? { work } : {}),
      workCode: link.vid,
      completenessCode: link.completeness,
    });
  }
  return rows;
}

export function vndbReleaseVocabularyAdmission(
  bindings: SourceVocabularyBindings,
  facts: VndbReleaseFacts,
  identities = new Map<string, NativeIdentity>(),
  releasePlatforms: ReadonlyMap<string, VndbReleasePlatformFacts> = new Map(),
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  return {
    request({ owner, subject }) {
      if (!subject) return;
      const rows = [
        ...vndbReleaseVocabulary(owner, subject, facts, identities),
        ...vndbReleasePlatformVocabulary(owner, subject, releasePlatforms),
      ];
      if (!rows.length) return;
      return { bindings, rows };
    },
  };
}

/** Select admitted works and their source releases from a bounded authored dump. One source release stays one native release. */
export async function planVndbReleaseFidelity(
  input: CrossMediaTables,
  options: { selectedWorkIds?: readonly string[] } = {},
): Promise<
  CrossMediaPlan & { facts: VndbReleaseFacts; releasePlatforms: ReadonlyMap<string, VndbReleasePlatformFacts> }
> {
  const plan: CrossMediaPlan = emptyCrossMediaPlan();
  const facts: VndbReleaseFacts = { works: new Map(), releases: new Map() };
  let omittedGaps = false;
  const gap = (table: string, record: Row, reason: string) => {
    if (plan.gaps.length < RELEASE_GAP_CAP) {
      plan.gaps.push({ source: 'vndb', fields: fieldsOf(table, record), record, reason });
    } else if (!omittedGaps) {
      omittedGaps = true;
      plan.gaps.push({
        source: 'vndb',
        fields: [],
        record: {},
        reason: 'Additional VNDB release diagnostics were omitted by the bounded result limit',
      });
    }
  };
  const scanGap = (table: string) => gap(table, { table }, 'VNDB release source scan exceeded its row or byte bound');
  const requestedIds = options.selectedWorkIds;
  let requested: Set<string> | undefined;
  if (requestedIds !== undefined) {
    requested = new Set(requestedIds);
    if (
      requestedIds.length > RELEASE_CAP ||
      requested.size !== requestedIds.length ||
      requestedIds.some((id) => !WORK_ID.test(id))
    ) {
      gap('vn', {}, 'Explicit selected work release traversal exceeds its bounded selection');
      return { ...plan, facts, releasePlatforms: new Map() };
    }
  }

  const rootWorkIds = new Set<string>();
  const workRows = new Map<string, Row>();
  let workScanComplete = true;
  try {
    for await (const row of boundedRows(input, 'vn')) {
      const id = String(row.id ?? '');
      if (requested && !requested.has(id)) continue;
      if (!WORK_ID.test(id)) {
        gap('vn', row, 'Invalid VNDB work identity');
        continue;
      }
      if (!requested && rootWorkIds.size >= RELEASE_CAP) {
        gap('vn', row, 'Work membership exceeds the bounded import cap');
        break;
      }
      if (rootWorkIds.has(id)) {
        gap('vn', row, 'Duplicate selected VNDB work');
        continue;
      }
      rootWorkIds.add(id);
      workRows.set(id, row);
    }
  } catch (error) {
    if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
    workScanComplete = false;
    scanGap('vn');
  }
  if (requested) {
    for (const id of requested) {
      if (!workRows.has(id)) gap('vn', { id }, 'Missing selected VNDB work');
    }
  }

  const rootReleaseIds = new Set<string>();
  const releaseIds = new Set<string>();
  const incompleteMembershipReleases = new Set<string>();
  const linkRows: { id: string; vid: string; completeness: string; record: Row }[] = [];
  const linkKeys = new Set<string>();
  const linksByRelease = new Map<string, number>();
  let membershipCount = 0;
  let membershipScanComplete = true;
  const addMembership = (row: Row, id: string, vid: string) => {
    const completeness = typeof row.rtype === 'string' && row.rtype ? row.rtype : '';
    const key = JSON.stringify([id, vid, row.rtype ?? null]);
    if (linkKeys.has(key)) return;
    const count = linksByRelease.get(id) ?? 0;
    if (membershipCount >= RELEASE_MEMBERSHIP_CAP || count >= sourceVocabularyLimits.rows) {
      incompleteMembershipReleases.add(id);
      gap('releases_vn', row, 'Release membership exceeds the bounded import cap');
      return;
    }
    linkKeys.add(key);
    membershipCount += 1;
    linksByRelease.set(id, count + 1);
    linkRows.push({ id, vid, completeness, record: { id, vid, rtype: row.rtype } });
  };
  try {
    for await (const row of boundedRows(input, 'releases_vn')) {
      const id = String(row.id ?? '');
      const vid = String(row.vid ?? '');
      if (!rootWorkIds.has(vid)) continue;
      if (!RELEASE_ID.test(id) || !WORK_ID.test(vid)) {
        gap('releases_vn', row, 'Invalid VNDB release-work identity');
        continue;
      }
      if (!releaseIds.has(id) && releaseIds.size >= RELEASE_CAP) {
        gap('releases_vn', row, 'Release membership exceeds the bounded import cap');
        continue;
      }
      releaseIds.add(id);
      rootReleaseIds.add(id);
      addMembership(row, id, vid);
    }
  } catch (error) {
    if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
    membershipScanComplete = false;
    scanGap('releases_vn');
  }

  type Supersession = { id: string; rid: string; record: Row };
  const outgoing = new Map<string, Supersession[]>();
  const malformed = new Map<string, Row[]>();
  let supersessionScanComplete = true;
  if (releaseIds.size) {
    try {
      for await (const row of boundedRows(input, 'releases_supersedes')) {
        const id = String(row.id ?? '');
        const rid = String(row.rid ?? '');
        if (!RELEASE_ID.test(id)) continue;
        if (!RELEASE_ID.test(rid) || id === rid) {
          const rows = malformed.get(id) ?? [];
          if (rows.length < 8) rows.push(row);
          malformed.set(id, rows);
          continue;
        }
        const rows = outgoing.get(id) ?? [];
        if (!rows.some((item) => item.rid === rid)) rows.push({ id, rid, record: { id, rid } });
        outgoing.set(id, rows);
      }
    } catch (error) {
      if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
      supersessionScanComplete = false;
      scanGap('releases_supersedes');
    }
  }

  const reached: Supersession[] = [];
  const reachedKeys = new Set<string>();
  const releaseDepth = new Map<string, number>([...releaseIds].map((id) => [id, 0]));
  const pending = [...releaseIds].map((id) => ({ id, depth: 0 }));
  while (pending.length && supersessionScanComplete) {
    const next = pending.shift()!;
    for (const row of malformed.get(next.id) ?? []) {
      gap('releases_supersedes', row, 'Invalid or self-referential VNDB release supersession');
    }
    for (const relation of outgoing.get(next.id) ?? []) {
      if (next.depth >= RELEASE_DEPTH_CAP) {
        gap('releases_supersedes', relation.record, 'VNDB release supersession depth exceeds its bound');
        continue;
      }
      const key = JSON.stringify([relation.id, relation.rid]);
      if (!releaseIds.has(relation.rid)) {
        if (releaseIds.size >= RELEASE_CAP) {
          gap('releases_supersedes', relation.record, 'VNDB release supersession endpoints exceed their bound');
          continue;
        }
        releaseIds.add(relation.rid);
        releaseDepth.set(relation.rid, next.depth + 1);
        pending.push({ id: relation.rid, depth: next.depth + 1 });
      }
      if (!reachedKeys.has(key) && reached.length < RELEASE_CAP * 2) {
        reachedKeys.add(key);
        reached.push(relation);
      } else if (!reachedKeys.has(key)) {
        gap('releases_supersedes', relation.record, 'VNDB release supersession rows exceed their bound');
      }
    }
  }

  const byReachableSource = new Map<string, Supersession[]>();
  for (const relation of reached) {
    const rows = byReachableSource.get(relation.id) ?? [];
    rows.push(relation);
    byReachableSource.set(relation.id, rows);
  }
  const cycleEdges = new Set<string>();
  const colors = new Map<string, 0 | 1 | 2>();
  const nodeStack: string[] = [];
  const edgeStack: Supersession[] = [];
  const edgeKey = (relation: Supersession) => JSON.stringify([relation.id, relation.rid]);
  const visit = (id: string) => {
    colors.set(id, 1);
    nodeStack.push(id);
    for (const relation of byReachableSource.get(id) ?? []) {
      const color = colors.get(relation.rid) ?? 0;
      if (color === 1) {
        cycleEdges.add(edgeKey(relation));
        const start = nodeStack.lastIndexOf(relation.rid);
        for (let index = start; index < edgeStack.length; index += 1)
          cycleEdges.add(edgeKey(edgeStack[index]!));
      } else if (color === 0) {
        edgeStack.push(relation);
        visit(relation.rid);
        edgeStack.pop();
      }
    }
    nodeStack.pop();
    colors.set(id, 2);
  };
  for (const id of rootReleaseIds) if ((colors.get(id) ?? 0) === 0) visit(id);
  if (cycleEdges.size) {
    const firstCycle = reached.find((relation) => cycleEdges.has(edgeKey(relation)))!;
    gap('releases_supersedes', firstCycle.record, 'VNDB release supersession cycle was omitted');
  }

  if (releaseIds.size) {
    try {
      for await (const row of boundedRows(input, 'releases_vn')) {
        const id = String(row.id ?? '');
        const vid = String(row.vid ?? '');
        if (!releaseIds.has(id)) continue;
        if (!RELEASE_ID.test(id) || !WORK_ID.test(vid)) {
          incompleteMembershipReleases.add(id);
          gap('releases_vn', row, 'Invalid VNDB release-work identity');
          continue;
        }
        addMembership(row, id, vid);
      }
    } catch (error) {
      if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
      membershipScanComplete = false;
      scanGap('releases_vn');
    }
  }

  const allWorkIds = new Set(rootWorkIds);
  const membershipWorkIds = new Set<string>();
  for (const link of linkRows) {
    if (rootWorkIds.has(link.vid)) continue;
    if (!requested) {
      gap('releases_vn', link.record, 'Release linked to an unselected work remains unused');
      continue;
    }
    if (!membershipWorkIds.has(link.vid) && allWorkIds.size >= RELEASE_WORK_ENDPOINT_CAP) {
      gap('releases_vn', link.record, 'Release work endpoints exceed their bounded import cap');
      continue;
    }
    membershipWorkIds.add(link.vid);
    allWorkIds.add(link.vid);
  }

  let extraWorkScanComplete = true;
  if (membershipWorkIds.size) {
    try {
      for await (const row of boundedRows(input, 'vn')) {
        const id = String(row.id ?? '');
        if (membershipWorkIds.has(id) && !workRows.has(id)) workRows.set(id, row);
      }
    } catch (error) {
      if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
      extraWorkScanComplete = false;
      scanGap('vn');
    }
    for (const id of membershipWorkIds) if (!workRows.has(id)) gap('vn', { id }, 'Missing release membership work');
  }

  const workTitles = new Map<string, Row[]>();
  const revisions = new Map<string, Row>();
  let titlesScanComplete = true;
  try {
    for await (const row of boundedRows(input, 'vn_titles')) {
      const id = String(row.id ?? '');
      if (!allWorkIds.has(id)) continue;
      if (row.official !== 't' && row.official !== 'f') {
        gap('vn_titles', row, 'Invalid VNDB official title flag');
        continue;
      }
      const rows = workTitles.get(id) ?? [];
      rows.push({ ...row, official: row.official === 't' });
      workTitles.set(id, rows);
    }
  } catch (error) {
    if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
    titlesScanComplete = false;
    scanGap('vn_titles');
  }
  let revisionsScanComplete = true;
  try {
    for await (const row of boundedRows(input, 'entry_meta')) {
      const id = String(row.id ?? '');
      if (!allWorkIds.has(id)) continue;
      if (revisions.has(id) || !/^[1-9][0-9]*$/u.test(String(row.revision ?? ''))) {
        gap('entry_meta', row, revisions.has(id) ? 'Duplicate selected VNDB revision' : 'Invalid VNDB revision');
        continue;
      }
      revisions.set(id, { id, revision: Number(row.revision), lastmod: row.lastmod });
    }
  } catch (error) {
    if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
    revisionsScanComplete = false;
    scanGap('entry_meta');
  }

  const readyWorkIds = new Set<string>();
  for (const id of allWorkIds) {
    const row = workRows.get(id);
    const entry_meta = revisions.get(id);
    const titles = workTitles.get(id);
    if (!row || !entry_meta || !titles?.length) {
      gap('vn', { id }, 'Missing selected VNDB record: ' + id);
      continue;
    }
    if (
      !workScanComplete ||
      !extraWorkScanComplete ||
      !titlesScanComplete ||
      !revisionsScanComplete
    )
      continue;
    readyWorkIds.add(id);
    if (rootWorkIds.has(id)) facts.works.set(id, { devstatus: decodeVndbDevstatus(row.devstatus) });
    const vn: Row = {
      id,
      olang: row.olang,
      ...(row.alias === null || row.alias === undefined ? {} : { alias: row.alias }),
    };
    plan.records.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles: titles },
    });
    plan.members.push({ source: 'vndb', key: id, kind: 'work', membership: 'referenced' });
  }

  const releaseLinks = new Map<string, { vid: string; completeness: string }[]>();
  const linksCompleteForRelease = new Map<string, boolean>();
  for (const id of releaseIds) {
    const allLinks = linkRows.filter((link) => link.id === id);
    const selectedLinks = allLinks.filter((link) => readyWorkIds.has(link.vid));
    releaseLinks.set(id, selectedLinks.map(({ vid, completeness }) => ({ vid, completeness })));
    linksCompleteForRelease.set(
      id,
      selectedLinks.length === allLinks.length && !incompleteMembershipReleases.has(id),
    );
  }

  let platformScanComplete = true;
  const releasePlatforms = await planVndbReleasePlatforms(
    {
      rows(provider, table, limits) {
        if (provider === 'vndb' && (table === 'releases_platforms' || table === 'releases_media'))
          return boundedRows(input, table);
        return input.rows(provider, table, limits);
      },
    },
    [...releaseIds].sort(compareText),
    new Map(
      [...releaseIds].map((id) => [
        id,
        Math.max(0, sourceVocabularyLimits.rows - 1 - (releaseLinks.get(id)?.length ?? 0)),
      ]),
    ),
  ).catch((error: unknown) => {
    if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
    platformScanComplete = false;
    scanGap(error.table);
    const empty = new Map<string, VndbReleasePlatformFacts>(
      [...releaseIds].map((id) => [id, { platforms: [], media: [] }]),
    );
    return { byRelease: empty, gaps: [] };
  });
  plan.gaps.push(...releasePlatforms.gaps.slice(0, Math.max(0, RELEASE_GAP_CAP - plan.gaps.length)));

  const releaseRows = new Map<string, Row>();
  let releasesScanComplete = true;
  if (releaseIds.size) {
    try {
      for await (const row of boundedRows(input, 'releases')) {
        const id = String(row.id ?? '');
        if (!releaseIds.has(id)) continue;
        if (releaseRows.has(id)) {
          gap('releases', row, 'Duplicate selected VNDB release');
          continue;
        }
        releaseRows.set(id, row);
      }
    } catch (error) {
      if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
      releasesScanComplete = false;
      scanGap('releases');
    }
  }
  const releaseTitleRows: Row[] = [];
  let releaseTitlesScanComplete = true;
  if (releaseIds.size) {
    try {
      for await (const row of boundedRows(input, 'releases_titles')) {
        if (releaseIds.has(String(row.id ?? ''))) releaseTitleRows.push(row);
      }
    } catch (error) {
      if (!(error instanceof CrossMediaTableScanLimitError)) throw error;
      releaseTitlesScanComplete = false;
      scanGap('releases_titles');
    }
  }

  const completeReleaseIds = new Set<string>();
  for (const id of releaseIds) {
    const row = releaseRows.get(id);
    if (!row) {
      gap('releases', { id }, 'Missing selected VNDB release');
      continue;
    }
    const bound = collectSelectedReleaseTitles(id, releaseTitleRows);
    for (const extra of bound.overflow) gap('releases_titles', extra, 'Release titles exceed the bounded import cap');
    for (const extra of bound.duplicates) gap('releases_titles', extra, 'Duplicate selected VNDB release title');
    if (!bound.titles.length) gap('releases_titles', { id }, 'Missing selected VNDB release title');
    const payload: Row = {
      ...row,
      id,
      ...(bound.titles.length ? { releases_titles: bound.titles } : {}),
    };
    const links = releaseLinks.get(id) ?? [];
    facts.releases.set(id, { released: row.released, links });
    const platformFacts = releasePlatforms.byRelease.get(id) ?? { platforms: [], media: [] };
    plan.entities.vndb.push({
      source: 'vndb',
      key: id,
      revision: null,
      payload: { ...payload, ...vndbReleasePlatformPayload(id, platformFacts) },
    });
    plan.members.push({ source: 'vndb', key: id, kind: 'release', membership: 'referenced' });
    if (
      bound.titles.length &&
      links.length &&
      linksCompleteForRelease.get(id) === true &&
      releasesScanComplete &&
      releaseTitlesScanComplete &&
      membershipScanComplete &&
      titlesScanComplete &&
      revisionsScanComplete &&
      platformScanComplete
    )
      completeReleaseIds.add(id);
    for (const link of links) {
      const edge: GraphEdgeDraft = {
        source: 'vndb',
        alias: crossMediaAliases.vndb,
        table: 'releases_vn',
        holder: id,
        target: link.vid,
        property: 'schema:exampleOfWork',
        url: vndbRecordUrl(id),
        membership: 'referenced',
        record: { id, vid: link.vid, rtype: link.completeness },
        fields: ['releases_vn.id', 'releases_vn.rtype', 'releases_vn.vid'],
      };
      plan.edges.push(edge);
    }
  }

  if (
    supersessionScanComplete &&
    membershipScanComplete &&
    releasesScanComplete &&
    releaseTitlesScanComplete &&
    platformScanComplete
  ) {
    for (const relation of reached) {
      if (cycleEdges.has(edgeKey(relation))) continue;
      if (!completeReleaseIds.has(relation.id) || !completeReleaseIds.has(relation.rid)) {
        gap('releases_supersedes', relation.record, 'Supersession endpoint is missing complete release evidence');
        continue;
      }
      if (releaseDepth.get(relation.id) === undefined || releaseDepth.get(relation.rid) === undefined) continue;
      plan.edges.push({
        source: 'vndb',
        alias: crossMediaAliases.vndb,
        table: 'releases_supersedes',
        holder: relation.id,
        target: relation.rid,
        property: 'rezics:releaseSupersedes',
        url: vndbRecordUrl(relation.id),
        membership: 'referenced',
        fenceFacts: true,
        record: relation.record,
        fields: ['releases_supersedes.id', 'releases_supersedes.rid'],
      });
    }
  }

  plan.records.vndb.sort((a, b) => a.key.localeCompare(b.key));
  plan.entities.vndb.sort((a, b) => a.key.localeCompare(b.key));
  plan.edges.sort(
    (a, b) =>
      a.table.localeCompare(b.table) ||
      a.holder.localeCompare(b.holder) ||
      a.target.localeCompare(b.target),
  );
  plan.releaseFacts = facts;
  return { ...plan, facts, releasePlatforms: releasePlatforms.byRelease };
}

export type VndbReleaseFidelityResult = CrossMediaSeedResult & {
  converterRevision: typeof entityRevision;
};

/** Production operator: import admitted VNDB releases through the existing seed/importer caller. */
export async function importVndbReleaseFidelity(input: {
  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings: SourceVocabularyBindings;
  bindingGroups?: readonly VndbReleaseBindingGroup[];
  destination?: { origin: string };
}): Promise<VndbReleaseFidelityResult> {
  const plan = await planVndbReleaseFidelity(input.tables);
  const [platformTaxonomy, mediumTaxonomy] = vndbReleaseClassificationTaxonomies();
  const neededCodes = new Map<string, Set<string>>([
    [platformTaxonomy!, new Set<string>()],
    [mediumTaxonomy!, new Set<string>()],
  ]);
  for (const facts of plan.releasePlatforms.values()) {
    for (const { code } of facts.platforms) neededCodes.get(platformTaxonomy!)!.add(code);
    for (const { code } of facts.media) neededCodes.get(mediumTaxonomy!)!.add(code);
  }
  const groups = Array.isArray(input.bindingGroups) ? input.bindingGroups : [];
  const boundedGroups: VndbReleaseBindingGroup[] = [];
  if (groups.length <= sourceVocabularyLimits.schemes) {
    let totalConcepts = 0;
    for (const group of groups) totalConcepts += group && Array.isArray(group.concepts) ? group.concepts.length : 0;
    if (totalConcepts <= sourceVocabularyLimits.concepts) {
      for (const group of groups) {
        const wanted = group && typeof group.taxonomy === 'string' ? neededCodes.get(group.taxonomy) : undefined;
        if (!wanted) continue;
        if (!Array.isArray(group.concepts)) continue;
        const concepts: VndbReleaseBindingGroup['concepts'] = group.concepts;
        boundedGroups.push({
          ...group,
          concepts: concepts.filter((item) => wanted.has(item.code)),
        });
      }
    }
  }
  const current = await readVndbReleaseBindings(input.port, boundedGroups);
  const classificationTaxonomies = new Set(vndbReleaseClassificationTaxonomies());
  const suppliedBindingsCurrent = input.bindings?.releaseDigest === bundledDigest;
  const suppliedSchemes =
    suppliedBindingsCurrent && Array.isArray(input.bindings?.schemes)
      ? input.bindings.schemes.slice(0, sourceVocabularyLimits.schemes)
      : [];
  const suppliedConcepts =
    suppliedBindingsCurrent && Array.isArray(input.bindings?.concepts)
      ? input.bindings.concepts.slice(0, sourceVocabularyLimits.concepts)
      : [];
  const bindings: SourceVocabularyBindings = {
    releaseDigest: bundledDigest,
    schemes: [
      ...current.schemes,
      ...suppliedSchemes.filter((group) => group && !classificationTaxonomies.has(group.taxonomy)),
    ].slice(0, sourceVocabularyLimits.schemes),
    concepts: [
      ...current.concepts,
      ...suppliedConcepts.filter((concept) => concept && !classificationTaxonomies.has(concept.taxonomy)),
    ].slice(0, sourceVocabularyLimits.concepts),
  };
  const result = await seedCrossMedia(plan, input.path, input.port, input.destination, {
    vocabularyAdmission: vndbReleaseVocabularyAdmission(bindings, plan.facts, new Map(), plan.releasePlatforms),
    recordConcurrency: 1,
  });
  return { ...result, converterRevision: entityRevision };
}

export type { CrossMediaGap, CrossMediaMember, CrossMediaReading, SourceRecord };
