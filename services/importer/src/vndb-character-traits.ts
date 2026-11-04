import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceRecord } from '@rezics/conversion';
import type {
  NativeIdentity,
  SourceVocabularyBindings,
  SourceVocabularyRequest,
  SourceVocabularyRow,
  VndbVocabularyRow,
} from '@rezics/conversion';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { vndbAppearanceRoleSchemeUri } from '@rezics/conversion/vndb-vocabulary';
import type { Owner } from './record-bindings.ts';
import {
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
import { VNDB_CHARACTER_APPEARANCE_COLUMNS, VNDB_CHARACTER_TRAIT_COLUMNS } from './vndb-tables.ts';

export const characterTraitSchemeUri = 'https://rezics.com/schemes/vndb/character-traits';
export const characterTraitTaxonomy = 'vndb.character-trait';
export const characterTraitConceptUri = (code: string) => `${characterTraitSchemeUri}/${code}`;
export const appearanceRoleSchemeUri = vndbAppearanceRoleSchemeUri;
export const appearanceRoleTaxonomy = 'vndb.char_role';
export const appearanceRoleConceptUri = (code: string) => `${appearanceRoleSchemeUri}/${code}`;

type Row = Record<string, unknown>;
const MEMBER_CAP = 64;
const characterId = /^c[1-9][0-9]*$/u;
const workId = /^v[1-9][0-9]*$/u;
const releaseId = /^r[1-9][0-9]*$/u;

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}
function copyInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) return Number(value);
  return undefined;
}
function copyFlag(value: unknown): boolean | undefined {
  if (value === true || value === 't') return true;
  if (value === false || value === 'f') return false;
  return undefined;
}
function copyId(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function adoptedContent(read: unknown, property: string): string | undefined {
  const statements = (read as { subject?: { statements?: Record<string, { value?: { content?: unknown } }[]> } })
    .subject?.statements?.[property];
  const content = statements?.[0]?.value?.content;
  return typeof content === 'string' ? content : undefined;
}

async function readSchemeConcepts(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known: {
    taxonomy: string;
    schemeUri: string;
    schemeId: string;
    conceptUri: (code: string) => string;
    concepts: readonly { code: string; id: string }[];
  },
): Promise<SourceVocabularyBindings> {
  const empty: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  let schemeRead;
  try {
    schemeRead = await port.readReviewedSubject(known.schemeId);
  } catch {
    return empty;
  }
  const scheme = schemeRead as { subject?: { id?: string; type?: string } };
  if (scheme.subject?.id !== known.schemeId || scheme.subject.type !== 'skos:ConceptScheme') return empty;
  if (adoptedContent(schemeRead, 'schema:url') !== known.schemeUri) return empty;
  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  for (const item of known.concepts) {
    let conceptRead;
    try {
      conceptRead = await port.readReviewedSubject(item.id);
    } catch {
      continue;
    }
    const concept = conceptRead as { subject?: { id?: string; type?: string } };
    if (concept.subject?.id !== item.id || concept.subject.type !== 'skos:Concept') continue;
    if (adoptedContent(conceptRead, 'schema:url') !== known.conceptUri(item.code)) continue;
    if (adoptedContent(conceptRead, 'skos:inScheme') !== known.schemeId) continue;
    concepts.push({
      taxonomy: known.taxonomy,
      code: item.code,
      id: item.id,
      type: 'skos:Concept',
      schemeId: known.schemeId,
      releaseDigest: bundledDigest,
    });
  }
  return {
    releaseDigest: bundledDigest,
    schemes: [
      {
        taxonomy: known.taxonomy,
        id: known.schemeId,
        uri: known.schemeUri,
        type: 'skos:ConceptScheme',
        releaseDigest: bundledDigest,
      },
    ],
    concepts,
  };
}

/** Current disclosed/adopted trait and appearance-role schemes. Retracted or hidden identities are withheld. */
export async function readVndbCharacterVocabularyBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known: {
    traits: { schemeId: string; concepts: readonly { code: string; id: string }[] };
    roles?: { schemeId: string; concepts: readonly { code: string; id: string }[] };
  },
): Promise<SourceVocabularyBindings> {
  const traits = await readSchemeConcepts(port, {
    taxonomy: characterTraitTaxonomy,
    schemeUri: characterTraitSchemeUri,
    schemeId: known.traits.schemeId,
    conceptUri: characterTraitConceptUri,
    concepts: known.traits.concepts,
  });
  const roles = known.roles
    ? await readSchemeConcepts(port, {
        taxonomy: appearanceRoleTaxonomy,
        schemeUri: appearanceRoleSchemeUri,
        schemeId: known.roles.schemeId,
        conceptUri: appearanceRoleConceptUri,
        concepts: known.roles.concepts,
      })
    : { schemes: [], concepts: [] };
  return {
    releaseDigest: bundledDigest,
    schemes: [...traits.schemes, ...roles.schemes],
    concepts: [...traits.concepts, ...roles.concepts],
  };
}

export type VndbCharacterTraitPlan = CrossMediaPlan & {
  traits: Row[];
  appearances: Row[];
};

function emptyPlan(): VndbCharacterTraitPlan {
  return { ...emptyCrossMediaPlan(), traits: [], appearances: [] };
}

/** Select admitted character/work members and retain exact unsupported source fields. */
export async function planVndbCharacterTraits(input: CrossMediaTables): Promise<VndbCharacterTraitPlan> {
  const plan = emptyPlan();
  const gap = (table: string, record: Row, reason: string) => {
    plan.gaps.push({ source: 'vndb', fields: fieldsOf(table, record), record, reason });
  };
  const member = (entry: CrossMediaMember) => {
    if (!plan.members.some((row) => row.source === entry.source && row.key === entry.key)) plan.members.push(entry);
  };
  const characters = new Set<string>();
  const works = new Set<string>();
  const referenced = new Set<string>();

  for await (const row of input.rows('vndb', 'chars_traits')) {
    const id = copyId(row.id, characterId);
    if (!id || typeof row.tid !== 'string' || !row.tid) {
      gap('chars_traits', row, 'Invalid VNDB character-trait identity');
      continue;
    }
    if (plan.traits.length >= MEMBER_CAP) {
      gap('chars_traits', row, 'Character-trait membership exceeds the bounded import cap');
      continue;
    }
    if (copyFlag(row.lie) === true)
      gap('chars_traits', row, 'chars_traits.lie is a false-positive association; it is not published as a trait fact');
    characters.add(id);
    plan.traits.push(row);
  }
  for await (const row of input.rows('vndb', 'chars_vns')) {
    const id = copyId(row.id, characterId);
    const vid = copyId(row.vid, workId);
    if (!id || !vid) {
      gap('chars_vns', row, 'Invalid VNDB character appearance identity');
      continue;
    }
    if (plan.appearances.length >= MEMBER_CAP) {
      gap('chars_vns', row, 'Character appearance membership exceeds the bounded import cap');
      continue;
    }
    const rid = row.rid === null || row.rid === undefined ? null : copyId(row.rid, releaseId);
    if (row.rid !== null && row.rid !== undefined && !rid) {
      gap('chars_vns', row, 'Invalid VNDB release-scoped appearance identity');
      continue;
    }
    if (rid)
      gap(
        'chars_vns',
        row,
        'chars_vns.rid is release-scoped appearance context; no release-scoped appearance term is selected',
      );
    characters.add(id);
    if (!rid) works.add(vid);
    plan.appearances.push(row);
  }

  const charRows = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'chars')) {
    const id = copyId(row.id, characterId);
    if (id && characters.has(id)) charRows.set(id, row);
  }
  for (const id of characters) {
    const row = charRows.get(id);
    if (!row) {
      gap('chars', { id }, 'Missing target record for this source relation');
      continue;
    }
    const main = copyId(row.main, characterId);
    if (main) {
      referenced.add(main);
      member({ source: 'vndb', key: main, kind: 'character', membership: 'referenced' });
      gap(
        'chars',
        { id: row.id, main: row.main, ...(row.main_spoil === undefined ? {} : { main_spoil: row.main_spoil }) },
        'chars.main is a referenced character endpoint; the source relation is not a standalone profile field',
      );
    }
  }
  if (referenced.size) {
    for await (const row of input.rows('vndb', 'chars')) {
      const id = copyId(row.id, characterId);
      if (id && referenced.has(id) && !charRows.has(id)) charRows.set(id, row);
    }
  }

  const titles = new Map<string, Row[]>(),
    vns = new Map<string, Row>(),
    revisions = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = copyId(row.id, workId);
    if (!id || !works.has(id)) continue;
    ensure(
      row.official === 't' || row.official === 'f' || typeof row.official === 'boolean',
      'Invalid VNDB official title flag',
    );
    titles.set(id, [...(titles.get(id) ?? []), { ...row, official: row.official === 't' || row.official === true }]);
  }
  for await (const row of input.rows('vndb', 'vn')) {
    const id = copyId(row.id, workId);
    if (!id || !works.has(id)) continue;
    vns.set(id, row);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = copyId(row.id, workId);
    if (!id || !works.has(id)) continue;
    const revision = copyInteger(row.revision);
    ensure(revision !== undefined && revision >= 1, 'Invalid VNDB revision');
    revisions.set(id, { id, revision, lastmod: row.lastmod });
  }

  for (const id of characters) {
    const row = charRows.get(id);
    if (!row) continue;
    plan.records.vndb.push({ source: 'vndb', key: id, revision: null, payload: row });
    member({ source: 'vndb', key: id, kind: 'character', membership: 'referenced' });
  }
  for (const id of referenced) {
    if (characters.has(id)) continue;
    const row = charRows.get(id);
    if (!row) {
      gap('chars', { id }, 'Missing target record for this source relation');
      continue;
    }
    plan.records.vndb.push({ source: 'vndb', key: id, revision: null, payload: row });
    member({ source: 'vndb', key: id, kind: 'character', membership: 'referenced' });
  }
  for (const id of works) {
    const row = vns.get(id),
      entry_meta = revisions.get(id),
      vn_titles = titles.get(id);
    if (!row || !entry_meta || !vn_titles) {
      gap('vn', { id }, 'Missing selected VNDB work record');
      continue;
    }
    const vn: Row = {
      id,
      olang: row.olang,
      ...(row.alias === null || row.alias === undefined ? {} : { alias: row.alias }),
    };
    plan.entities.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles },
    });
    member({ source: 'vndb', key: id, kind: 'work', membership: 'referenced' });
  }
  plan.records.vndb.sort((a, b) => a.key.localeCompare(b.key));
  plan.entities.vndb.sort((a, b) => a.key.localeCompare(b.key));
  return plan;
}

function traitRows(owner: Owner, subject: string, plan: VndbCharacterTraitPlan): SourceVocabularyRequest['rows'] {
  if (!characterId.test(owner.external_id)) return [];
  const character: NativeIdentity = { id: subject, type: 'wd:Q95074', releaseDigest: bundledDigest };
  const rows: SourceVocabularyRow[] = [];
  for (const record of plan.traits) {
    if (record.id !== owner.external_id) continue;
    const spoiler = copyInteger(record.spoil);
    const lie = record.lie === undefined || record.lie === null ? undefined : copyFlag(record.lie);
    if (spoiler === undefined || typeof record.tid !== 'string') continue;
    rows.push({
      kind: 'character-trait',
      path: `/chars_traits/${record.id}/${record.tid}`,
      character,
      code: record.tid,
      spoiler,
      ...(lie === undefined ? {} : { lie }),
    });
  }
  return rows;
}

function appearanceRows(
  owner: Owner,
  subject: string,
  plan: VndbCharacterTraitPlan,
  identities: Map<string, NativeIdentity>,
): SourceVocabularyRequest['rows'] {
  if (!workId.test(owner.external_id)) return [];
  const work: NativeIdentity = { id: subject, type: 'wd:Q689445', releaseDigest: bundledDigest };
  const rows: SourceVocabularyRow[] = [];
  for (const record of plan.appearances) {
    if (record.vid !== owner.external_id) continue;
    const spoiler = copyInteger(record.spoil);
    if (spoiler === undefined || typeof record.role !== 'string' || typeof record.id !== 'string') continue;
    const releaseCode = record.rid === null || record.rid === undefined ? null : copyId(record.rid, releaseId);
    const character = identities.get(record.id);
    const row: VndbVocabularyRow = {
      kind: 'character-appearance',
      path: `/chars_vns/${record.id}/${record.vid}${releaseCode ? `/${releaseCode}` : ''}`,
      subject: work,
      ...(character === undefined ? {} : { character }),
      characterCode: record.id,
      roleCode: record.role,
      spoiler,
      ...(releaseCode ? { releaseCode } : record.rid === null ? { releaseCode: null } : {}),
    };
    rows.push(row);
  }
  return rows;
}

export function vndbCharacterVocabularyAdmission(
  bindings: SourceVocabularyBindings,
  plan: VndbCharacterTraitPlan,
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  const identities = new Map<string, NativeIdentity>();
  return {
    request({ owner, subject }) {
      if (!subject) return;
      if (characterId.test(owner.external_id))
        identities.set(owner.external_id, { id: subject, type: 'wd:Q95074', releaseDigest: bundledDigest });
      if (workId.test(owner.external_id))
        identities.set(owner.external_id, { id: subject, type: 'wd:Q689445', releaseDigest: bundledDigest });
      const rows = characterId.test(owner.external_id)
        ? traitRows(owner, subject, plan)
        : appearanceRows(owner, subject, plan, identities);
      if (!rows.length) return;
      return { bindings, rows };
    },
  };
}

export type VndbCharacterTraitsResult = CrossMediaSeedResult & {
  converterRevision: typeof entityRevision;
};

/** Production operator: import admitted traits and qualified appearances through the existing seed caller. */
export async function importVndbCharacterTraits(input: {
  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings: SourceVocabularyBindings;
  destination?: { origin: string };
}): Promise<VndbCharacterTraitsResult> {
  const plan = await planVndbCharacterTraits(input.tables);
  const result = await seedCrossMedia(plan, input.path, input.port, input.destination, {
    vocabularyAdmission: vndbCharacterVocabularyAdmission(input.bindings, plan),
    recordConcurrency: 1,
  });
  return { ...result, converterRevision: entityRevision };
}

export { VNDB_CHARACTER_APPEARANCE_COLUMNS, VNDB_CHARACTER_TRAIT_COLUMNS };
export type { CrossMediaGap, CrossMediaMember, CrossMediaReading, SourceRecord };
