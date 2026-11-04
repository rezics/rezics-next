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
const WORK_ID = /^v[1-9][0-9]*$/;
const RELEASE_ID = /^r[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

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
      pending = Promise.resolve().then(() => port.readReviewedSubject(id)).catch(() => undefined);
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
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(item.code) || !UUID.test(item.id))
        continue;
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
): Promise<CrossMediaPlan & { facts: VndbReleaseFacts; releasePlatforms: ReadonlyMap<string, VndbReleasePlatformFacts> }> {
  const plan: CrossMediaPlan = emptyCrossMediaPlan();
  const facts: VndbReleaseFacts = { works: new Map(), releases: new Map() };
  const gap = (table: string, record: Row, reason: string) => {
    plan.gaps.push({ source: 'vndb', fields: fieldsOf(table, record), record, reason });
  };
  const vnIds = new Set<string>();
  const vns = new Map<string, Row>();
  const titles = new Map<string, Row[]>();
  const revisions = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'vn')) {
    if (vnIds.size >= RELEASE_CAP) {
      gap('vn', row, 'Work membership exceeds the bounded import cap');
      continue;
    }
    try {
      const id = text(row, 'id');
      ensure(WORK_ID.test(id), 'Invalid VNDB work identity');
      ensure(!vns.has(id), 'Duplicate selected VNDB work');
      vnIds.add(id);
      vns.set(id, row);
    } catch {
      gap('vn', row, 'Invalid VNDB work identity');
    }
  }
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = String(row.id ?? '');
    if (!vnIds.has(id)) continue;
    ensure(row.official === 't' || row.official === 'f', 'Invalid VNDB official title flag');
    titles.set(id, [...(titles.get(id) ?? []), { ...row, official: row.official === 't' }]);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = String(row.id ?? '');
    if (!vnIds.has(id)) continue;
    ensure(!revisions.has(id), 'Duplicate selected VNDB revision');
    ensure(/^[1-9][0-9]*$/u.test(text(row, 'revision')), 'Invalid VNDB revision');
    revisions.set(id, { id, revision: Number(row.revision), lastmod: row.lastmod });
  }
  const releaseIds = new Set<string>();
  const links = new Map<string, { vid: string; completeness: string }[]>();
  for await (const row of input.rows('vndb', 'releases_vn')) {
    let id: string;
    let vid: string;
    try {
      id = text(row, 'id');
      vid = text(row, 'vid');
      ensure(RELEASE_ID.test(id), 'Invalid VNDB release identity');
      ensure(WORK_ID.test(vid), 'Invalid VNDB work identity');
    } catch {
      gap('releases_vn', row, 'Invalid VNDB release-work identity');
      continue;
    }
    if (!vnIds.has(vid)) {
      gap('releases_vn', row, 'Missing target record for this source relation');
      continue;
    }
    if (releaseIds.size >= RELEASE_CAP && !releaseIds.has(id)) {
      gap('releases_vn', row, 'Release membership exceeds the bounded import cap');
      continue;
    }
    releaseIds.add(id);
    const completeness = typeof row.rtype === 'string' && row.rtype ? row.rtype : '';
    links.set(id, [...(links.get(id) ?? []), { vid, completeness }]);
  }
  const vocabularySlots = new Map(
    [...releaseIds].map((id) => [id, Math.max(0, sourceVocabularyLimits.rows - 1 - (links.get(id)?.length ?? 0))]),
  );
  const releasePlatforms = await planVndbReleasePlatforms(input, [...releaseIds].sort(), vocabularySlots);
  plan.gaps.push(...releasePlatforms.gaps);
  const releases = new Map<string, Row>();
  const releaseTitleRows: Row[] = [];
  for await (const row of input.rows('vndb', 'releases')) {
    const id = String(row.id ?? '');
    if (!releaseIds.has(id)) continue;
    releases.set(id, row);
  }
  for await (const row of input.rows('vndb', 'releases_titles')) {
    const id = String(row.id ?? '');
    if (!releaseIds.has(id)) continue;
    releaseTitleRows.push(row);
  }
  for await (const row of input.rows('vndb', 'releases_supersedes')) {
    const id = String(row.id ?? '');
    if (!releaseIds.has(id) && !releaseIds.has(String(row.rid ?? ''))) continue;
    gap('releases_supersedes', row, 'Release-to-release supersession is not representable on the shared follows term');
  }
  for (const id of vnIds) {
    const row = vns.get(id),
      entry_meta = revisions.get(id);
    if (!row || !entry_meta || !titles.has(id)) {
      gap('vn', { id }, `Missing selected VNDB record: ${id}`);
      continue;
    }
    const vn: Row = {
      id,
      olang: row.olang,
      ...(row.alias === null || row.alias === undefined ? {} : { alias: row.alias }),
    };
    facts.works.set(id, { devstatus: decodeVndbDevstatus(row.devstatus) });
    plan.records.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles: titles.get(id)! },
    });
    plan.members.push({ source: 'vndb', key: id, kind: 'work', membership: 'referenced' });
  }
  for (const id of releaseIds) {
    const row = releases.get(id);
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
    const releaseLinks = links.get(id) ?? [];
    facts.releases.set(id, { released: row.released, links: releaseLinks });
    plan.entities.vndb.push({
      source: 'vndb',
      key: id,
      revision: null,
      payload: { ...payload, ...vndbReleasePlatformPayload(id, releasePlatforms.byRelease.get(id)!) },
    });
    plan.members.push({ source: 'vndb', key: id, kind: 'release', membership: 'referenced' });
    for (const link of releaseLinks) {
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
  plan.records.vndb.sort((a, b) => a.key.localeCompare(b.key));
  plan.entities.vndb.sort((a, b) => a.key.localeCompare(b.key));
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
    for (const group of groups)
      totalConcepts += group && Array.isArray(group.concepts) ? group.concepts.length : 0;
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
  const suppliedSchemes = suppliedBindingsCurrent && Array.isArray(input.bindings?.schemes)
    ? input.bindings.schemes.slice(0, sourceVocabularyLimits.schemes)
    : [];
  const suppliedConcepts = suppliedBindingsCurrent && Array.isArray(input.bindings?.concepts)
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
