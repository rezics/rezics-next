import { bundledDigest } from '@rezics/definitions/bundled';
import { sourceDigest } from '../../../packages/conversion/src/support.ts';
import type { SourceRecord } from '@rezics/conversion';
import type {
  NativeIdentity,
  SourceVocabularyBindings,
  SourceVocabularyRequest,
  VndbVocabularyRow,
} from '@rezics/conversion';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
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

export const creditTypeSchemeUri = 'https://vndb.org/credit-types';
export const creditTypeTaxonomy = 'vndb.credit_type';
export const creditTypeConceptUri = (code: string) => `${creditTypeSchemeUri}/${code}`;
export const vndbStaffCreditConverterRevision = 'vndb-staff-credits@1';
const VN_CAP = 8;
const CREDIT_CAP = 64;
type Row = Record<string, unknown>;

export type VndbStaffCredit = {
  vn: string;
  staffId: string;
  aliasId: string;
  kind: 'staff' | 'voice';
  sourcePath: string;
  recordRevision: string;
  sourceDigest: string;
  role?: string;
  creditedAs?: string;
  characterId?: string;
};
export type VndbStaffCreditPlan = CrossMediaPlan & { staffCredits: VndbStaffCredit[] };
export type VndbCreditVocabularyReadFailure = Readonly<
  | { scope: 'scheme' }
  | { scope: 'concept'; code: string }
>;

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
function staffPersonId(value: string): boolean {
  return /^s[1-9][0-9]*$/.test(value);
}
function creditedSpelling(note: unknown, aliasName: string | undefined): { value?: string; invalid?: true } {
  if (note !== undefined && note !== null && note !== '') {
    if (typeof note === 'string' && note.isWellFormed() && note.trim() && note.length <= 1500) return { value: note };
    return { invalid: true };
  }
  if (aliasName === undefined) return {};
  if (aliasName.isWellFormed() && aliasName.trim() && aliasName.length <= 1500) return { value: aliasName };
  return { invalid: true };
}
function adoptedContent(read: unknown, property: string): string | undefined {
  const statements = (read as { subject?: { statements?: Record<string, { value?: { content?: unknown } }[]> } })
    .subject?.statements?.[property];
  if (!statements || statements.length !== 1) return undefined;
  const content = statements[0]?.value?.content;
  return typeof content === 'string' ? content : undefined;
}
function identity(id: string, type: string): NativeIdentity {
  return { id, type, releaseDigest: bundledDigest };
}

/** Current disclosed/adopted credit-type scheme and concepts. Retracted or hidden identities are withheld. */
export async function readCreditTypeBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known: { schemeId: string; concepts: readonly { code: string; id: string }[] },
): Promise<SourceVocabularyBindings> {
  return (await readCreditTypeBindingsDetailed(port, known)).bindings;
}

/** Keep an unavailable native read distinct from a disclosed but non-current binding. */
export async function readCreditTypeBindingsDetailed(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known: { schemeId: string; concepts: readonly { code: string; id: string }[] },
  readPublicSubject?: (id: string) => Promise<unknown>,
): Promise<{ bindings: SourceVocabularyBindings; unavailable: VndbCreditVocabularyReadFailure[] }> {
  const empty: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  const unavailable: VndbCreditVocabularyReadFailure[] = [];
  let schemeRead;
  try {
    schemeRead = await port.readReviewedSubject(known.schemeId);
  } catch {
    return { bindings: empty, unavailable: [{ scope: 'scheme' }] };
  }
  const scheme = schemeRead as { subject?: { id?: string; type?: string } };
  if (scheme.subject?.id !== known.schemeId || scheme.subject.type !== 'skos:ConceptScheme')
    return { bindings: empty, unavailable };
  if (adoptedContent(schemeRead, 'schema:url') !== creditTypeSchemeUri) return { bindings: empty, unavailable };
  if (readPublicSubject) {
    let publicScheme;
    try {
      publicScheme = await readPublicSubject(known.schemeId);
    } catch {
      return { bindings: empty, unavailable: [{ scope: 'scheme' }] };
    }
    const current = publicScheme as { subject?: { id?: string; type?: string } };
    if (
      current.subject?.id !== known.schemeId ||
      current.subject.type !== 'skos:ConceptScheme' ||
      adoptedContent(publicScheme, 'schema:url') !== creditTypeSchemeUri
    )
      return { bindings: empty, unavailable };
  }
  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  for (const item of known.concepts) {
    let conceptRead;
    try {
      conceptRead = await port.readReviewedSubject(item.id);
    } catch {
      unavailable.push({ scope: 'concept', code: item.code });
      continue;
    }
    const concept = conceptRead as { subject?: { id?: string; type?: string } };
    if (concept.subject?.id !== item.id || concept.subject.type !== 'skos:Concept') continue;
    if (adoptedContent(conceptRead, 'schema:url') !== creditTypeConceptUri(item.code)) continue;
    if (adoptedContent(conceptRead, 'skos:inScheme') !== known.schemeId) continue;
    if (readPublicSubject) {
      let publicConcept;
      try {
        publicConcept = await readPublicSubject(item.id);
      } catch {
        unavailable.push({ scope: 'concept', code: item.code });
        continue;
      }
      const current = publicConcept as { subject?: { id?: string; type?: string } };
      if (
        current.subject?.id !== item.id ||
        current.subject.type !== 'skos:Concept' ||
        adoptedContent(publicConcept, 'schema:url') !== creditTypeConceptUri(item.code) ||
        adoptedContent(publicConcept, 'skos:inScheme') !== known.schemeId
      )
        continue;
    }
    concepts.push({
      taxonomy: creditTypeTaxonomy,
      code: item.code,
      id: item.id,
      type: 'skos:Concept',
      schemeId: known.schemeId,
      releaseDigest: bundledDigest,
    });
  }
  return {
    bindings: {
      releaseDigest: bundledDigest,
      schemes: [
        {
          taxonomy: creditTypeTaxonomy,
          id: known.schemeId,
          uri: creditTypeSchemeUri,
          type: 'skos:ConceptScheme',
          releaseDigest: bundledDigest,
        },
      ],
      concepts,
    },
    unavailable,
  };
}

export function staffCreditVocabulary(
  owner: Owner,
  subject: string,
  credits: readonly VndbStaffCredit[],
  identities: ReadonlyMap<string, NativeIdentity>,
): SourceVocabularyRequest['rows'] {
  if (!/^v[1-9][0-9]*$/.test(owner.external_id)) return [];
  const vn = identity(subject, 'wd:Q689445');
  const rows: VndbVocabularyRow[] = [];
  for (const credit of credits) {
    if (credit.vn !== owner.external_id || rows.length >= CREDIT_CAP) continue;
    const holder = identities.get(credit.staffId);
    if (credit.kind === 'voice') {
      const character = credit.characterId ? identities.get(credit.characterId) : undefined;
      rows.push({
        kind: 'voice-credit',
        path: credit.sourcePath,
        origin: {
          externalId: credit.vn,
          revision: credit.recordRevision,
          digest: credit.sourceDigest,
          url: vndbRecordUrl(credit.vn),
          converterRevision: vndbStaffCreditConverterRevision,
        },
        subject: vn,
        ...(holder === undefined ? {} : { performer: holder }),
        performerCode: credit.staffId,
        ...(character === undefined ? {} : { character }),
        characterCode: credit.characterId ?? '',
        ...(credit.creditedAs === undefined ? {} : { creditedAs: credit.creditedAs }),
      });
      continue;
    }
    rows.push({
      kind: 'staff',
      path: credit.sourcePath,
      origin: {
        externalId: credit.vn,
        revision: credit.recordRevision,
        digest: credit.sourceDigest,
        url: vndbRecordUrl(credit.vn),
        converterRevision: vndbStaffCreditConverterRevision,
      },
      subject: vn,
      ...(holder === undefined ? {} : { holder }),
      holderCode: credit.staffId,
      roleCode: credit.role ?? '',
      ...(credit.creditedAs === undefined ? {} : { creditedAs: credit.creditedAs }),
    });
  }
  return rows;
}

export function staffCreditVocabularyAdmission(
  bindings: SourceVocabularyBindings,
  credits: readonly VndbStaffCredit[],
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  const identities = new Map<string, NativeIdentity>();
  return {
    request({ owner, subject }) {
      if (!subject) return;
      if (staffPersonId(owner.external_id)) identities.set(owner.external_id, identity(subject, 'schema:Person'));
      if (/^c[1-9][0-9]*$/.test(owner.external_id)) identities.set(owner.external_id, identity(subject, 'wd:Q95074'));
      const rows = staffCreditVocabulary(owner, subject, credits, identities);
      if (!rows.length) return;
      return { bindings, rows };
    },
  };
}

/** Select admitted VNs, staff aliases and voice rows from a bounded authored dump. */
export async function planVndbStaffCredits(input: CrossMediaTables): Promise<VndbStaffCreditPlan> {
  const plan: VndbStaffCreditPlan = { ...emptyCrossMediaPlan(), staffCredits: [] };
  const gap = (table: string, record: Row, reason: string) => {
    plan.gaps.push({ source: 'vndb', fields: fieldsOf(table, record), record, reason });
  };
  const member = (entry: CrossMediaMember) => {
    if (!plan.members.some((row) => row.source === entry.source && row.key === entry.key)) plan.members.push(entry);
  };
  const titles = new Map<string, Row[]>(),
    vns = new Map<string, Row>(),
    revisions = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    try {
      const id = text(row, 'id');
      if (!/^v[1-9][0-9]*$/.test(id)) continue;
      titles.set(id, [...(titles.get(id) ?? []), { ...row, official: row.official === 't' || row.official === true }]);
    } catch {
      gap('vn_titles', row, 'Invalid VNDB title identity');
    }
  }
  for await (const row of input.rows('vndb', 'vn')) {
    try {
      const id = text(row, 'id');
      if (!/^v[1-9][0-9]*$/.test(id) || vns.has(id)) continue;
      vns.set(id, row);
    } catch {
      gap('vn', row, 'Invalid VNDB work identity');
    }
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    try {
      const id = text(row, 'id');
      if (!/^v[1-9][0-9]*$/.test(id) || revisions.has(id)) continue;
      ensure(/^[1-9][0-9]*$/.test(text(row, 'revision')), 'Invalid VNDB revision');
      revisions.set(id, { id, revision: Number(row.revision), lastmod: row.lastmod });
    } catch {
      gap('entry_meta', row, 'Invalid VNDB revision');
    }
  }
  const vnIds: string[] = [];
  for (const id of vns.keys()) {
    if (!titles.has(id) || !revisions.has(id)) {
      gap('vn', { id }, 'Missing selected VNDB record');
      continue;
    }
    if (vnIds.length >= VN_CAP) {
      gap('vn', { id }, 'Visual novel membership exceeds the bounded import cap');
      continue;
    }
    vnIds.push(id);
  }
  const admitted = new Set(vnIds);
  const aliases = new Set<string>(),
    chars = new Set<string>(),
    staffCredits: { table: 'vn_staff' | 'vn_seiyuu'; row: Row }[] = [];
  for await (const row of input.rows('vndb', 'vn_staff')) {
    try {
      if (!admitted.has(text(row, 'id'))) continue;
      aliases.add(text(row, 'aid'));
      staffCredits.push({ table: 'vn_staff', row });
    } catch {
      gap('vn_staff', row, 'Invalid VNDB staff credit identity');
    }
  }
  for await (const row of input.rows('vndb', 'vn_seiyuu')) {
    try {
      if (!admitted.has(text(row, 'id'))) continue;
      aliases.add(text(row, 'aid'));
      chars.add(text(row, 'cid'));
      staffCredits.push({ table: 'vn_seiyuu', row });
    } catch {
      gap('vn_seiyuu', row, 'Invalid VNDB voice credit identity');
    }
  }
  const aliasToStaff = new Map<string, string>();
  const aliasNames = new Map<string, string>();
  const staffIds = new Set<string>();
  for await (const row of input.rows('vndb', 'staff_alias')) {
    try {
      const aid = text(row, 'aid');
      if (!aliases.has(aid)) continue;
      const sid = text(row, 'id');
      aliasToStaff.set(aid, sid);
      if (typeof row.name === 'string' && row.name) aliasNames.set(aid, row.name);
      staffIds.add(sid);
    } catch {
      gap('staff_alias', row, 'Invalid VNDB staff alias identity');
    }
  }
  const staffRows = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'staff')) {
    try {
      const id = text(row, 'id');
      if (staffIds.has(id)) staffRows.set(id, row);
    } catch {
      gap('staff', row, 'Invalid VNDB staff identity');
    }
  }
  const charRows = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'chars')) {
    try {
      const id = text(row, 'id');
      if (chars.has(id)) charRows.set(id, row);
    } catch {
      gap('chars', row, 'Invalid VNDB character identity');
    }
  }
  for (const { table, row } of staffCredits) {
    if (plan.staffCredits.length >= CREDIT_CAP) {
      gap(table, row, 'Staff credit membership exceeds the bounded import cap');
      continue;
    }
    const aid = text(row, 'aid');
    const sid = aliasToStaff.get(aid);
    if (!sid) {
      gap(table, row, 'Missing target record for this source relation');
      continue;
    }
    if (!staffPersonId(sid) || !staffRows.has(sid)) {
      gap(table, row, 'Staff kind is not a person identity');
      continue;
    }
    const spelling = creditedSpelling(row.note, aliasNames.get(aid));
    if (spelling.invalid) {
      gap(table, row, 'Credited spelling is not admitted as a native qualifier');
      continue;
    }
    if (table === 'vn_seiyuu') {
      const vn = text(row, 'id');
      const characterId = text(row, 'cid');
      if (!charRows.has(characterId)) {
        gap(table, row, 'Missing target record for this source relation');
        continue;
      }
      plan.staffCredits.push({
        vn,
        staffId: sid,
        aliasId: aid,
        kind: 'voice',
        sourcePath: `/vn_seiyuu/${vn}/${aid}/${characterId}`,
        recordRevision: String((revisions.get(vn) as { revision: number }).revision),
        sourceDigest: sourceDigest(row),
        characterId,
        ...(spelling.value === undefined ? {} : { creditedAs: spelling.value }),
      });
      continue;
    }
    const vn = text(row, 'id');
    const role = text(row, 'role');
    plan.staffCredits.push({
      vn,
      staffId: sid,
      aliasId: aid,
      kind: 'staff',
      sourcePath: `/vn_staff/${vn}/${aid}/${role}`,
      recordRevision: String((revisions.get(vn) as { revision: number }).revision),
      sourceDigest: sourceDigest(row),
      role,
      ...(spelling.value === undefined ? {} : { creditedAs: spelling.value }),
    });
  }
  for (const id of vnIds) {
    const row = vns.get(id)!,
      entry_meta = revisions.get(id)!;
    const vn: Row = {
      id,
      olang: row.olang,
      ...(row.alias === null || row.alias === undefined ? {} : { alias: row.alias }),
    };
    plan.records.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles: titles.get(id)! },
    });
    member({ source: 'vndb', key: id, kind: 'work', membership: 'referenced' });
  }
  const usedStaff = new Set(plan.staffCredits.map((credit) => credit.staffId));
  const usedChars = new Set(plan.staffCredits.flatMap((credit) => (credit.characterId ? [credit.characterId] : [])));
  for (const id of usedStaff) {
    const row = staffRows.get(id)!;
    const name = [...aliasNames.entries()].find((entry) => aliasToStaff.get(entry[0]) === id)?.[1];
    plan.entities.vndb.push({
      source: 'vndb',
      key: id,
      revision: null,
      payload: { ...row, ...(name ? { name } : {}) },
    });
    member({ source: 'vndb', key: id, kind: 'person', membership: 'referenced' });
  }
  for (const id of usedChars) {
    plan.entities.vndb.push({ source: 'vndb', key: id, revision: null, payload: charRows.get(id)! });
    member({ source: 'vndb', key: id, kind: 'character', membership: 'referenced' });
  }
  plan.records.vndb.sort((a, b) => a.key.localeCompare(b.key));
  plan.entities.vndb.sort((a, b) => a.key.localeCompare(b.key));
  return plan;
}

export type VndbStaffCreditsResult = CrossMediaSeedResult & {
  converterRevision: typeof entityRevision;
  credits: VndbStaffCredit[];
};

/** Production operator: import admitted staff aliases and exact roles through the existing seed/importer caller. */
export async function importVndbStaffCredits(input: {
  tables: CrossMediaTables;
  path: string;
  port: CrossMediaPort;
  bindings: SourceVocabularyBindings;
  destination?: { origin: string };
}): Promise<VndbStaffCreditsResult> {
  const plan = await planVndbStaffCredits(input.tables);
  const result = await seedCrossMedia(plan, input.path, input.port, input.destination, {
    entitiesFirst: true,
    recordConcurrency: 1,
    vocabularyAdmission: staffCreditVocabularyAdmission(input.bindings, plan.staffCredits),
  });
  return { ...result, converterRevision: entityRevision, credits: plan.staffCredits };
}

export type { CrossMediaGap, CrossMediaMember, CrossMediaReading, SourceRecord };
