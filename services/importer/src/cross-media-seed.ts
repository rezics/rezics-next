import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import {
  bangumiRecordUrl,
  converter_revision as entityRevision,
  isFamilyRelationTerm,
  liveActionWorkType,
  mapSourceEnumeration,
  vndbRecordUrl,
} from '@rezics/conversion/cross-media-entities';
import { subjectSlug } from '@rezics/definitions/slug';
import { createAccountTokenProvider, VNDB_IMPORTER_SCOPES } from './credentials.ts';
import { CrossMediaGraph, citedProviderBinding, type GraphEdgeDraft } from './cross-media-bindings.ts';
import { createImportTransport, type ReviewedSubjectRead } from './import-client.ts';
import { createImporter, type ImportRunResult } from './importer.ts';
import { createSourceRegistration } from './source-registry.ts';

type Provider = 'bangumi' | 'vndb';
type Row = Record<string, unknown>;
export type Franchise = 'steins-gate' | 'clannad' | 'fate';
const patterns: Record<Franchise, RegExp> = {
  'steins-gate': /^(?:STEINS[;；]GATE|シュタインズ[・･]ゲート|命运石之门)(?:$|[\s:：0])/i,
  clannad: /^CLANNAD(?:$|[\s:：])/i,
  fate: /^(?:Fate\s*[/／]|フェイト\s*[/／])/i,
};
export const crossMediaAliases = { bangumi: 'bangumi_cross_media', vndb: 'vndb_cross_media' } as const;
const FAMILY_CAP = 256;

/** Membership uses titles only, never synopsis mentions, credits or a shared actor. */
export function crossMediaFranchise(...names: unknown[]): Franchise | undefined {
  return (Object.keys(patterns) as Franchise[]).find((family) =>
    names.some((name) => typeof name === 'string' && patterns[family].test(name.trim())),
  );
}

export interface CrossMediaTables {
  rows(provider: Provider, table: string): AsyncIterable<Row>;
}
export type CrossMediaGap = {
  source: Provider;
  /** Exact dump columns, including qualifications, ordering and original endpoint IDs. */
  fields: string[];
  record: Row;
  reason: string;
};
export type CrossMediaMember = {
  source: Provider;
  key: string;
  kind: 'work' | 'character' | 'person' | 'episode' | 'release' | 'organization';
  membership: 'family' | 'referenced';
  franchise?: Franchise;
};
export type CrossMediaPlan = {
  records: Record<Provider, SourceRecord[]>;
  entities: Record<Provider, SourceRecord[]>;
  edges: GraphEdgeDraft[];
  franchises: Record<Franchise, { bangumi: string[]; vndb: string[] }>;
  members: CrossMediaMember[];
  gaps: CrossMediaGap[];
};
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function text(row: Row, field: string): string {
  const value = row[field];
  ensure(typeof value === 'string' && value.length > 0, `Missing source field: ${field}`);
  return value;
}
function number(row: Row, field: string): number {
  const value = row[field];
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, `Invalid Bangumi ${field}`);
  return value;
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}
function emptyFranchises(): Record<Franchise, { bangumi: string[]; vndb: string[] }> {
  return {
    'steins-gate': { bangumi: [], vndb: [] },
    clannad: { bangumi: [], vndb: [] },
    fate: { bangumi: [], vndb: [] },
  };
}

function bangumiRelation(type: number, code: unknown) {
  return mapSourceEnumeration('bangumi', `relation.${type}`, code as number);
}

function countFamily<K>(franchiseOf: Map<K, Franchise>, family: Franchise): number {
  let count = 0;
  for (const value of franchiseOf.values()) if (value === family) count++;
  return count;
}

/** Select a finite family catalogue; unsupported native rows remain explicit source gaps.
 * Ported selection/incident-edge shape: legacy-final:scripts/datasets/{bangumi,vndb}.ts.
 * Title matching locates records only; identities bind only through cited provider URLs.
 */
export async function planCrossMediaSeed(input: CrossMediaTables): Promise<CrossMediaPlan> {
  const plan: CrossMediaPlan = {
    records: { bangumi: [], vndb: [] },
    entities: { bangumi: [], vndb: [] },
    edges: [],
    franchises: emptyFranchises(),
    members: [],
    gaps: [],
  };
  const gap = (source: Provider, table: string, record: Row, reason: string) => {
    plan.gaps.push({ source, fields: fieldsOf(table, record), record, reason });
  };
  const edge = (draft: GraphEdgeDraft) => plan.edges.push(draft);
  const member = (entry: CrossMediaMember) => {
    if (!plan.members.some((row) => row.source === entry.source && row.key === entry.key)) plan.members.push(entry);
  };
  const tagged = (franchise: Franchise | undefined): { franchise: Franchise } | {} => (franchise ? { franchise } : {});

  const types = new Map<number, number>();
  const titled = new Map<number, Franchise>();
  for await (const row of input.rows('bangumi', 'subject')) {
    const id = number(row, 'id');
    ensure(!types.has(id), 'Duplicate selected Bangumi subject');
    types.set(id, row.type as number);
    const family = crossMediaFranchise(row.name, row.name_cn);
    if (family) titled.set(id, family);
  }
  const familyIds = new Map<number, Franchise>(titled);
  const referencedWorks = new Map<number, Franchise>();
  let grew = true;
  while (grew) {
    grew = false;
    for await (const row of input.rows('bangumi', 'subject-relations')) {
      const sid = number(row, 'subject_id');
      const rid = number(row, 'related_subject_id');
      const known = familyIds.get(sid) ?? familyIds.get(rid);
      if (!known) continue;
      const holderType = types.get(sid);
      if (holderType === undefined) {
        gap('bangumi', 'subject-relations', row, 'Missing target record for this source relation');
        continue;
      }
      const mapping = bangumiRelation(holderType, row.relation_type);
      if (!mapping?.term || mapping.status === 'omitted' || !isFamilyRelationTerm(mapping.term)) continue;
      const other = familyIds.has(sid) ? rid : sid;
      const otherFamily = familyIds.get(other);
      if (otherFamily && otherFamily !== known) {
        referencedWorks.set(other, known);
        continue;
      }
      if (!familyIds.has(other) && types.has(other) && countFamily(familyIds, known) < FAMILY_CAP) {
        familyIds.set(other, known);
        grew = true;
      } else if (!types.has(other)) {
        gap('bangumi', 'subject-relations', row, 'Missing target record for this source relation');
      }
    }
  }

  const subjects = new Map<number, Row>();
  const anime = new Set<Franchise>();
  for await (const row of input.rows('bangumi', 'subject')) {
    const id = number(row, 'id');
    if (!familyIds.has(id) && !referencedWorks.has(id)) continue;
    subjects.set(id, row);
  }
  for (const [id, family] of familyIds) {
    const row = subjects.get(id);
    if (!row) {
      gap('bangumi', 'subject', { id }, 'Missing target record for this source relation');
      continue;
    }
    const type = row.type as number;
    if (type === 2 && titled.has(id)) anime.add(family);
    plan.franchises[family].bangumi.push(String(id));
    member({ source: 'bangumi', key: String(id), kind: 'work', membership: 'family', franchise: family });
    if (type === 3) {
      plan.entities.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
      continue;
    }
    if (type === 6) {
      if (!liveActionWorkType(row.platform)) {
        gap('bangumi', 'subject', row, 'Live-action platform is not a pinned film or TV code');
        continue;
      }
      plan.entities.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
      continue;
    }
    if (![1, 2, 4].includes(type)) {
      gap('bangumi', 'subject', row, 'Source work type is outside the registered Bangumi conversion scope');
      continue;
    }
    plan.records.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
  }
  for (const [id, family] of referencedWorks) {
    if (familyIds.has(id) || !subjects.has(id)) continue;
    member({ source: 'bangumi', key: String(id), kind: 'work', membership: 'referenced', franchise: family });
    const row = subjects.get(id)!;
    if ([1, 2, 4].includes(row.type as number))
      plan.records.bangumi.push({ source: 'bangumi', key: String(id), revision: null, payload: row });
  }

  for await (const row of input.rows('bangumi', 'subject-relations')) {
    const sid = number(row, 'subject_id');
    const rid = number(row, 'related_subject_id');
    if (!familyIds.has(sid) && !familyIds.has(rid) && !referencedWorks.has(sid) && !referencedWorks.has(rid)) continue;
    const holderType = types.get(sid);
    const mapping = holderType === undefined ? undefined : bangumiRelation(holderType, row.relation_type);
    if (!mapping?.term || mapping.status === 'omitted') {
      gap(
        'bangumi',
        'subject-relations',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
      );
      continue;
    }
    const holder = mapping.inverse ? String(rid) : String(sid);
    const target = mapping.inverse ? String(sid) : String(rid);
    const membership = isFamilyRelationTerm(mapping.term) ? 'family' : 'referenced';
    const order = row.order;
    edge({
      source: 'bangumi',
      alias: crossMediaAliases.bangumi,
      table: 'subject-relations',
      holder,
      target,
      property: mapping.term,
      url: bangumiRecordUrl(holder),
      membership,
      record: row,
      fields: fieldsOf('subject-relations', row),
      ...(typeof order === 'number'
        ? {
            qualifiers: [
              { property: 'schema:position', content: { amount: String(order < 1 ? order + 1 : order), unit: '1' } },
            ],
          }
        : {}),
    });
  }

  const characters = new Set<number>();
  const persons = new Set<number>();
  const familyWorks = new Set(familyIds.keys());
  for await (const row of input.rows('bangumi', 'subject-characters'))
    if (familyWorks.has(number(row, 'subject_id'))) characters.add(number(row, 'character_id'));
  for await (const row of input.rows('bangumi', 'subject-persons')) {
    if (!familyWorks.has(number(row, 'subject_id'))) continue;
    persons.add(number(row, 'person_id'));
  }
  for await (const row of input.rows('bangumi', 'person-characters')) {
    if (!familyWorks.has(number(row, 'subject_id')) && !characters.has(number(row, 'character_id'))) continue;
    persons.add(number(row, 'person_id'));
    characters.add(number(row, 'character_id'));
  }
  for await (const row of input.rows('bangumi', 'subject-characters')) {
    if (!characters.has(number(row, 'character_id'))) continue;
    const work = String(number(row, 'subject_id'));
    const character = `character:${number(row, 'character_id')}`;
    const mapping = mapSourceEnumeration('bangumi', 'subject-characters.type', row.type as number);
    member({
      source: 'bangumi',
      key: character,
      kind: 'character',
      membership: familyWorks.has(number(row, 'subject_id')) ? 'family' : 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    const qualifiers: { property: string; content: unknown }[] = [];
    if (mapping?.concept)
      gap('bangumi', 'subject-characters', row, 'Appearance role concept has no resolved native Concept binding');
    else if (mapping?.status === 'omitted')
      gap('bangumi', 'subject-characters', row, mapping.reason ?? 'Unsupported appearance role');
    edge({
      source: 'bangumi',
      alias: crossMediaAliases.bangumi,
      table: 'subject-characters',
      holder: work,
      target: character,
      property: 'schema:character',
      url: bangumiRecordUrl(work),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('subject-characters', row),
      ...(qualifiers.length ? { qualifiers } : {}),
    });
  }
  for await (const row of input.rows('bangumi', 'subject-persons')) {
    if (!familyWorks.has(number(row, 'subject_id'))) continue;
    const work = String(number(row, 'subject_id'));
    const person = `person:${number(row, 'person_id')}`;
    const workType = types.get(number(row, 'subject_id'));
    const mapping = mapSourceEnumeration('bangumi', `staff.${workType}`, row.position as number);
    member({
      source: 'bangumi',
      key: person,
      kind: 'person',
      membership: 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    if (!mapping?.term || mapping.status === 'omitted') {
      gap(
        'bangumi',
        'subject-persons',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
      );
      continue;
    }
    const qualifiers: { property: string; content: unknown }[] = [];
    if (typeof row.appear_eps === 'string' && row.appear_eps)
      qualifiers.push({ property: 'wdt:P518', content: row.appear_eps });
    edge({
      source: 'bangumi',
      alias: crossMediaAliases.bangumi,
      table: 'subject-persons',
      holder: work,
      target: person,
      property: mapping.term,
      url: bangumiRecordUrl(work),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('subject-persons', row),
      ...(qualifiers.length ? { qualifiers } : {}),
    });
  }
  for await (const row of input.rows('bangumi', 'person-characters')) {
    if (!familyWorks.has(number(row, 'subject_id')) && !characters.has(number(row, 'character_id'))) continue;
    const work = String(number(row, 'subject_id'));
    const person = `person:${number(row, 'person_id')}`;
    const character = `character:${number(row, 'character_id')}`;
    member({
      source: 'bangumi',
      key: person,
      kind: 'person',
      membership: 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    member({
      source: 'bangumi',
      key: character,
      kind: 'character',
      membership: 'referenced',
      ...tagged(familyIds.get(number(row, 'subject_id'))),
    });
    if (!familyWorks.has(number(row, 'subject_id')) && !familyIds.has(number(row, 'subject_id'))) {
      gap(
        'bangumi',
        'person-characters',
        row,
        'Voice credit work is outside the elected family; appearance retained as a referenced endpoint',
      );
    }
    edge({
      source: 'bangumi',
      alias: crossMediaAliases.bangumi,
      table: 'person-characters',
      holder: work,
      target: person,
      property: 'wdt:P725',
      url: bangumiRecordUrl(work),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('person-characters', row),
      qualifiers: [{ property: 'wdt:P453', content: character }],
    });
  }
  const corePersons = new Set(persons),
    coreCharacters = new Set(characters);
  for await (const row of input.rows('bangumi', 'person-relations')) {
    ensure(row.person_type === 'prsn' || row.person_type === 'crt', 'Unknown Bangumi person_type');
    const core = row.person_type === 'prsn' ? corePersons : coreCharacters;
    if (!core.has(row.person_id as number) && !core.has(row.related_person_id as number)) continue;
    gap('bangumi', 'person-relations', row, 'No registered native converter for this source relation or entity');
    const all = row.person_type === 'prsn' ? persons : characters;
    if (typeof row.person_id === 'number') all.add(row.person_id);
    if (typeof row.related_person_id === 'number') all.add(row.related_person_id);
  }
  for await (const row of input.rows('bangumi', 'character'))
    if (characters.has(number(row, 'id'))) {
      plan.entities.bangumi.push({
        source: 'bangumi',
        key: `character:${row.id}`,
        revision: null,
        payload: row,
      });
      member({ source: 'bangumi', key: `character:${row.id}`, kind: 'character', membership: 'referenced' });
    }
  for await (const row of input.rows('bangumi', 'person'))
    if (persons.has(number(row, 'id'))) {
      plan.entities.bangumi.push({ source: 'bangumi', key: `person:${row.id}`, revision: null, payload: row });
      member({ source: 'bangumi', key: `person:${row.id}`, kind: 'person', membership: 'referenced' });
    }
  for await (const row of input.rows('bangumi', 'episode'))
    if (familyWorks.has(number(row, 'subject_id'))) {
      plan.entities.bangumi.push({ source: 'bangumi', key: `episode:${row.id}`, revision: null, payload: row });
      member({
        source: 'bangumi',
        key: `episode:${row.id}`,
        kind: 'episode',
        membership: 'referenced',
        ...tagged(familyIds.get(number(row, 'subject_id'))),
      });
      edge({
        source: 'bangumi',
        alias: crossMediaAliases.bangumi,
        table: 'episode',
        holder: `episode:${row.id}`,
        target: String(row.subject_id),
        property: 'schema:isPartOf',
        url: bangumiRecordUrl(`episode:${row.id}`),
        membership: 'referenced',
        record: row,
        fields: fieldsOf('episode', row),
        ...(row.sort !== undefined ? { qualifiers: [{ property: 'schema:episodeNumber', content: row.sort }] } : {}),
      });
    }

  const vnIds = new Set<string>();
  const vnFamily = new Map<string, Franchise>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const family = crossMediaFranchise(row.title, row.latin);
    if (!family) continue;
    const id = text(row, 'id');
    ensure(/^v[1-9][0-9]*$/.test(id), 'Invalid VNDB work identity');
    vnIds.add(id);
    vnFamily.set(id, family);
    if (!plan.franchises[family].vndb.includes(id)) plan.franchises[family].vndb.push(id);
  }
  let vnGrew = true;
  while (vnGrew) {
    vnGrew = false;
    for await (const row of input.rows('vndb', 'vn_relations')) {
      const id = text(row, 'id');
      const vid = text(row, 'vid');
      const known = vnFamily.get(id) ?? vnFamily.get(vid);
      if (!known) continue;
      const mapping = mapSourceEnumeration('vndb', 'vn_relation', text(row, 'relation'));
      if (!mapping?.term || mapping.status === 'omitted' || !isFamilyRelationTerm(mapping.term)) continue;
      const other = vnFamily.has(id) ? vid : id;
      if (!vnFamily.has(other) && countFamily(vnFamily, known) < FAMILY_CAP) {
        vnFamily.set(other, known);
        vnIds.add(other);
        if (!plan.franchises[known].vndb.includes(other)) plan.franchises[known].vndb.push(other);
        vnGrew = true;
      }
    }
  }
  const titles = new Map<string, Row[]>(),
    vns = new Map<string, Row>(),
    revisions = new Map<string, Row>();
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(row.official === 't' || row.official === 'f', 'Invalid VNDB official title flag');
    const title = { ...row, official: row.official === 't' };
    titles.set(id, [...(titles.get(id) ?? []), title]);
  }
  for await (const row of input.rows('vndb', 'vn')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(!vns.has(id), 'Duplicate selected VNDB work');
    vns.set(id, row);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = text(row, 'id');
    if (!vnIds.has(id)) continue;
    ensure(!revisions.has(id), 'Duplicate selected VNDB revision');
    ensure(/^[1-9][0-9]*$/.test(text(row, 'revision')), 'Invalid VNDB revision');
    revisions.set(id, { id, revision: Number(row.revision), lastmod: row.lastmod });
  }
  for (const id of vnIds) {
    const row = vns.get(id),
      entry_meta = revisions.get(id);
    ensure(row && entry_meta && titles.has(id), `Missing selected VNDB record: ${id}`);
    const vn: Row = { id, olang: row.olang, ...(row.alias === null ? {} : { alias: row.alias }) };
    if (row.c_votecount !== undefined || row.c_average !== undefined) {
      ensure(
        typeof row.c_votecount === 'string' && /^(?:0|[1-9][0-9]*)$/.test(row.c_votecount),
        'Invalid VNDB vote count',
      );
      ensure(
        row.c_average === null || (typeof row.c_average === 'string' && /^(?:0|[1-9][0-9]*)$/.test(row.c_average)),
        'Invalid VNDB average',
      );
      vn.c_votecount = Number(row.c_votecount);
      vn.c_average = row.c_average === null ? null : Number(row.c_average);
    }
    plan.records.vndb.push({
      source: 'vndb',
      key: id,
      revision: String(entry_meta.revision),
      payload: { vn, entry_meta, vn_titles: titles.get(id)! },
    });
    member({ source: 'vndb', key: id, kind: 'work', membership: 'family', ...tagged(vnFamily.get(id)) });
  }
  for await (const row of input.rows('vndb', 'vn_relations')) {
    const id = text(row, 'id');
    const vid = text(row, 'vid');
    if (!vnIds.has(id) && !vnIds.has(vid)) continue;
    const mapping = mapSourceEnumeration('vndb', 'vn_relation', text(row, 'relation'));
    if (!mapping?.term || mapping.status === 'omitted') {
      gap(
        'vndb',
        'vn_relations',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
      );
      continue;
    }
    const holder = mapping.inverse ? vid : id;
    const target = mapping.inverse ? id : vid;
    if (!vnIds.has(target)) {
      gap('vndb', 'vn_relations', row, 'Missing target record for this source relation');
      continue;
    }
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'vn_relations',
      holder,
      target,
      property: mapping.term,
      url: vndbRecordUrl(holder),
      membership: isFamilyRelationTerm(mapping.term) ? 'family' : 'referenced',
      record: row,
      fields: fieldsOf('vn_relations', row),
    });
  }
  const releases = new Set<string>(),
    chars = new Set<string>(),
    aliases = new Set<string>(),
    staff = new Set<string>();
  for await (const row of input.rows('vndb', 'releases_vn'))
    if (vnIds.has(text(row, 'vid'))) releases.add(text(row, 'id'));
  for await (const row of input.rows('vndb', 'releases_vn')) {
    if (!releases.has(text(row, 'id'))) continue;
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'releases_vn',
      holder: text(row, 'id'),
      target: text(row, 'vid'),
      property: 'schema:exampleOfWork',
      url: vndbRecordUrl(text(row, 'id')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('releases_vn', row),
    });
    member({
      source: 'vndb',
      key: text(row, 'id'),
      kind: 'release',
      membership: 'referenced',
      ...tagged(vnFamily.get(text(row, 'vid'))),
    });
  }
  for await (const row of input.rows('vndb', 'vn_staff')) {
    if (!vnIds.has(text(row, 'id'))) continue;
    aliases.add(text(row, 'aid'));
    const mapping = mapSourceEnumeration('vndb', 'credit_type', text(row, 'role'));
    if (!mapping?.term || mapping.status === 'omitted') {
      gap(
        'vndb',
        'vn_staff',
        row,
        mapping?.reason ?? 'No registered native converter for this source relation or entity',
      );
      continue;
    }
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'vn_staff',
      holder: text(row, 'id'),
      target: `staff-alias:${text(row, 'aid')}`,
      property: mapping.term,
      url: vndbRecordUrl(text(row, 'id')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('vn_staff', row),
    });
  }
  for await (const row of input.rows('vndb', 'vn_seiyuu')) {
    if (!vnIds.has(text(row, 'id'))) continue;
    aliases.add(text(row, 'aid'));
    chars.add(text(row, 'cid'));
    const qualifiers: { property: string; content: unknown }[] = [{ property: 'wdt:P453', content: text(row, 'cid') }];
    if (typeof row.note === 'string' && row.note) qualifiers.push({ property: 'wdt:P1932', content: row.note });
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'vn_seiyuu',
      holder: text(row, 'id'),
      target: `staff-alias:${text(row, 'aid')}`,
      property: 'wdt:P725',
      url: vndbRecordUrl(text(row, 'id')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('vn_seiyuu', row),
      qualifiers,
    });
  }
  for await (const row of input.rows('vndb', 'chars_vns')) if (vnIds.has(text(row, 'vid'))) chars.add(text(row, 'id'));
  for await (const row of input.rows('vndb', 'chars_vns')) {
    if (!chars.has(text(row, 'id'))) continue;
    if (!vnIds.has(text(row, 'vid'))) {
      gap('vndb', 'chars_vns', row, 'Missing target record for this source relation');
      continue;
    }
    const role = mapSourceEnumeration('vndb', 'char_role', text(row, 'role'));
    if (role?.status === 'omitted') gap('vndb', 'chars_vns', row, role.reason ?? 'Unsupported character role');
    else if (role?.term === 'wdt:P3831')
      gap('vndb', 'chars_vns', row, 'Appearance role concept has no resolved native Concept binding');
    edge({
      source: 'vndb',
      alias: crossMediaAliases.vndb,
      table: 'chars_vns',
      holder: text(row, 'vid'),
      target: text(row, 'id'),
      property: 'schema:character',
      url: vndbRecordUrl(text(row, 'vid')),
      membership: 'referenced',
      record: row,
      fields: fieldsOf('chars_vns', row),
    });
    member({
      source: 'vndb',
      key: text(row, 'id'),
      kind: 'character',
      membership: 'referenced',
      ...tagged(vnFamily.get(text(row, 'vid'))),
    });
  }
  for await (const row of input.rows('vndb', 'staff_alias'))
    if (aliases.has(text(row, 'aid'))) staff.add(text(row, 'id'));
  const aliasToStaff = new Map<string, string>();
  const staffNames = new Map<string, string>();
  for await (const row of input.rows('vndb', 'staff_alias')) {
    if (!staff.has(text(row, 'id'))) continue;
    aliasToStaff.set(text(row, 'aid'), text(row, 'id'));
    if (typeof row.name === 'string' && row.name) staffNames.set(text(row, 'id'), row.name);
  }
  for (const draft of plan.edges) {
    if (draft.source !== 'vndb' || !draft.target.startsWith('staff-alias:')) continue;
    const aid = draft.target.slice('staff-alias:'.length);
    const sid = aliasToStaff.get(aid);
    if (!sid) {
      gap('vndb', draft.table, draft.record, 'Missing target record for this source relation');
      draft.target = aid;
      continue;
    }
    draft.target = sid;
    member({ source: 'vndb', key: sid, kind: 'person', membership: 'referenced' });
  }
  for await (const row of input.rows('vndb', 'chars')) {
    if (!chars.has(text(row, 'id'))) continue;
    if (typeof row.main === 'string' && /^c[1-9][0-9]*$/.test(row.main)) {
      chars.add(row.main);
      member({ source: 'vndb', key: row.main, kind: 'character', membership: 'referenced' });
      gap(
        'vndb',
        'chars',
        { id: row.id, main: row.main },
        'chars.main is a referenced character endpoint; the source relation is not a standalone profile field',
      );
    }
    plan.entities.vndb.push({ source: 'vndb', key: text(row, 'id'), revision: null, payload: row });
  }
  for await (const row of input.rows('vndb', 'staff'))
    if (staff.has(text(row, 'id')))
      plan.entities.vndb.push({
        source: 'vndb',
        key: text(row, 'id'),
        revision: null,
        payload: { ...row, ...(staffNames.get(text(row, 'id')) ? { name: staffNames.get(text(row, 'id')) } : {}) },
      });
  for await (const row of input.rows('vndb', 'releases'))
    if (releases.has(text(row, 'id')))
      plan.entities.vndb.push({ source: 'vndb', key: text(row, 'id'), revision: null, payload: row });
  for await (const row of input.rows('vndb', 'vn_anime'))
    if (vnIds.has(text(row, 'id')))
      gap('vndb', 'vn_anime', row, 'VNDB anime.aid is an AniDB identifier, not a Bangumi or native subject identity');
  const producers = new Set<string>(),
    animeIds = new Set<string>(),
    links = new Set<string>();
  const vnLinks = new Map<string, string>();
  for await (const row of input.rows('vndb', 'releases_producers')) {
    if (!releases.has(text(row, 'id'))) continue;
    producers.add(text(row, 'pid'));
    const developer = row.developer === 't' || row.developer === true;
    const publisher = row.publisher === 't' || row.publisher === true;
    if (developer)
      edge({
        source: 'vndb',
        alias: crossMediaAliases.vndb,
        table: 'releases_producers',
        holder: text(row, 'id'),
        target: text(row, 'pid'),
        property: 'wdt:P178',
        url: vndbRecordUrl(text(row, 'id')),
        membership: 'referenced',
        record: row,
        fields: fieldsOf('releases_producers', row),
      });
    if (publisher)
      edge({
        source: 'vndb',
        alias: crossMediaAliases.vndb,
        table: 'releases_producers',
        holder: text(row, 'id'),
        target: text(row, 'pid'),
        property: 'schema:publisher',
        url: vndbRecordUrl(text(row, 'id')),
        membership: 'referenced',
        record: row,
        fields: fieldsOf('releases_producers', row),
      });
    if (!developer && !publisher)
      gap('vndb', 'releases_producers', row, 'Release producer role flags do not select a native credit');
  }
  for await (const row of input.rows('vndb', 'releases_supersedes')) {
    if (!releases.has(text(row, 'id'))) continue;
    releases.add(text(row, 'rid') as string);
    member({ source: 'vndb', key: text(row, 'rid'), kind: 'release', membership: 'referenced' });
    gap(
      'vndb',
      'releases_supersedes',
      row,
      'Release-to-release supersession is not representable on the shared follows term',
    );
  }
  for (const [table, ids] of [
    ['releases_titles', releases],
    ['staff_extlinks', staff],
    ['vn_extlinks', vnIds],
  ] as const)
    for await (const row of input.rows('vndb', table)) {
      if (!ids.has(text(row, 'id'))) continue;
      if (table === 'vn_extlinks' || table === 'staff_extlinks') {
        links.add(text(row, 'link'));
        if (table === 'vn_extlinks') vnLinks.set(text(row, 'link'), text(row, 'id'));
      }
      if (table === 'releases_titles') continue;
    }
  for await (const row of input.rows('vndb', 'staff'))
    if (staff.has(text(row, 'id')) && typeof row.prod === 'string') producers.add(row.prod);
  for await (const row of input.rows('vndb', 'vn_anime'))
    if (vnIds.has(text(row, 'id'))) animeIds.add(text(row, 'aid'));
  for await (const row of input.rows('vndb', 'producers'))
    if (producers.has(text(row, 'id'))) {
      plan.entities.vndb.push({ source: 'vndb', key: text(row, 'id'), revision: null, payload: row });
      member({ source: 'vndb', key: text(row, 'id'), kind: 'organization', membership: 'referenced' });
    }
  for await (const row of input.rows('vndb', 'anime'))
    if (animeIds.has(text(row, 'id')))
      gap('vndb', 'anime', row, 'VNDB anime.aid is an AniDB identifier, not a Bangumi or native subject identity');
  for await (const row of input.rows('vndb', 'extlinks')) {
    if (!links.has(text(row, 'id')) && !links.has(String(row.id))) continue;
    const value = typeof row.value === 'string' ? row.value : '';
    const cited = citedProviderBinding(value);
    const owner = vnLinks.get(text(row, 'id')) ?? vnLinks.get(String(row.id));
    if (cited?.provider === 'bangumi' && owner && vnIds.has(owner)) {
      edge({
        source: 'vndb',
        alias: crossMediaAliases.vndb,
        table: 'extlinks',
        holder: owner,
        target: cited.key.replace(/^subject:/, ''),
        property: 'wdt:P5732',
        url: value,
        targetKind: 'literal',
        membership: 'referenced',
        record: row,
        fields: fieldsOf('extlinks', row),
      });
      continue;
    }
    if (cited?.provider === 'bangumi') {
      gap(
        'vndb',
        'extlinks',
        row,
        'Cited Bangumi URL is retained as provider provenance; identities are not merged by title',
      );
      continue;
    }
    if (row.site !== 'website')
      gap('vndb', 'extlinks', row, 'Unsupported external link site; retained as source metadata only');
  }

  for (const family of Object.keys(patterns) as Franchise[])
    ensure(anime.has(family) && plan.franchises[family].vndb.length, `Missing anime/VN pair for ${family}`);
  for (const provider of ['bangumi', 'vndb'] as const) {
    const registration = createSourceRegistration(provider, {
      source: crossMediaAliases[provider],
      converterRevision: entityRevision,
    });
    for (const row of [...plan.records[provider], ...plan.entities[provider]])
      registration.convert(
        { external_id: row.key, record_revision: row.revision, record: row.payload },
        { source: registration.source },
      );
    plan.records[provider].sort((a, b) => a.key.localeCompare(b.key));
    plan.entities[provider].sort((a, b) => a.key.localeCompare(b.key));
  }
  for (const family of Object.values(plan.franchises)) {
    family.bangumi.sort();
    family.vndb.sort();
  }
  return plan;
}

/** PostgreSQL COPY text escaping, ported from legacy-final:scripts/datasets/vndb.ts. */
export function decodeCrossMediaCopy(value: string): string | null {
  if (value === '\\N') return null;
  return value.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_match, code: string) => {
    const escapes: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
    if (code.startsWith('x')) return String.fromCharCode(parseInt(code.slice(1), 16));
    return escapes[code] ?? code;
  });
}

/** Extracted official dump tables only. No remote acquisition, SQL execution or platform database access. */
export class CrossMediaDumpFiles implements CrossMediaTables {
  readonly digests = new Map<string, string>();
  constructor(
    private readonly bangumi: string,
    private readonly vndb: string,
  ) {}
  async *rows(provider: Provider, table: string): AsyncGenerator<Row> {
    ensure(/^[a-z][a-z_-]*$/.test(table), 'Invalid dump table name');
    const file = provider === 'bangumi' ? join(this.bangumi, `${table}.jsonlines`) : join(this.vndb, 'db', table);
    const header = provider === 'vndb' ? await readFile(`${file}.header`) : null;
    const columns = header ? header.toString('utf8').trimEnd().split('\t') : null;
    if (columns) {
      ensure(columns.length > 0 && new Set(columns).size === columns.length, 'Invalid VNDB header');
      const headerKey = `${provider}/${table}.header`,
        hash = createHash('sha256').update(header!).digest('hex');
      ensure(!this.digests.has(headerKey) || this.digests.get(headerKey) === hash, 'Dump changed during selection');
      this.digests.set(headerKey, hash);
    }
    const stream = createReadStream(file);
    const digest = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    async function* lines() {
      let pending = '';
      for await (const chunk of stream) {
        digest.update(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) !== -1) {
          ensure(Buffer.byteLength(pending.slice(0, end)) <= 1024 * 1024, 'Dump row exceeds seed input limit');
          yield pending.slice(0, end).replace(/\r$/, '');
          pending = pending.slice(end + 1);
        }
        ensure(Buffer.byteLength(pending) <= 1024 * 1024, 'Dump row exceeds seed input limit');
      }
      pending += decoder.decode();
      if (pending) yield pending;
    }
    try {
      for await (const line of lines()) {
        if (!line) continue;
        ensure(Buffer.byteLength(line) <= 1024 * 1024, 'Dump row exceeds seed input limit');
        if (columns) {
          const cells = line.split('\t');
          ensure(cells.length === columns.length, `Invalid VNDB column count: ${table}`);
          yield Object.fromEntries(columns.map((column, i) => [column, decodeCrossMediaCopy(cells[i]!)]));
        } else {
          const row: unknown = JSON.parse(line);
          ensure(row && typeof row === 'object' && !Array.isArray(row), 'Invalid Bangumi row');
          yield row as Row;
        }
      }
    } finally {
      stream.destroy();
    }
    const key = `${provider}/${table}`,
      hash = digest.digest('hex');
    ensure(!this.digests.has(key) || this.digests.get(key) === hash, 'Dump changed during selection');
    this.digests.set(key, hash);
  }
}

export type CrossMediaPort = Pick<
  ReturnType<typeof createImportTransport>,
  | 'batch'
  | 'setSourceRecordMetadata'
  | 'fence'
  | 'writeSourceStatistic'
  | 'clearSourceStatistic'
  | 'readReviewedSubject'
>;
export type CrossMediaReading = {
  source: Provider;
  externalId: string;
  subject: ReviewedSubjectRead;
  route: string;
  selection: 'selected' | 'proposed';
};
export type CrossMediaSeedResult = {
  status: 'imported' | 'imported-with-gaps';
  franchises: CrossMediaPlan['franchises'];
  members: CrossMediaMember[];
  runs: Partial<Record<Provider, ImportRunResult>>;
  readings: CrossMediaReading[];
  gaps: CrossMediaGap[];
  unresolved: { holder: string; target: string; property: string; reason: string }[];
};

function subjectRoute(read: ReviewedSubjectRead): string {
  const subject = (read as { subject?: { id?: string; labels?: Record<string, string> } }).subject;
  const id = subject?.id;
  const labels = subject?.labels ?? {};
  const label = labels.und ?? labels.en ?? labels.ja ?? labels.zh ?? Object.values(labels)[0] ?? 'subject';
  return id ? `/subjects/${id}/${subjectSlug(label)}` : '/subjects';
}

export async function seedCrossMedia(
  plan: CrossMediaPlan,
  path: string,
  port: CrossMediaPort,
  destination?: { origin: string },
) {
  const importer = createImporter({
    path,
    ...(destination ? { destination } : {}),
    transport: {
      batchWrite: (request) => port.batch(request),
      setSourceRecordMetadata: (request, signal) => port.setSourceRecordMetadata(request, signal),
      readFence: (tuple) =>
        port.fence({ source: tuple.source, externalId: tuple.external_id, fieldGroup: tuple.field_group }),
      writeSourceStatistic: (request, signal) => port.writeSourceStatistic(request, signal),
      clearSourceStatistic: (request, signal) => port.clearSourceStatistic(request, signal),
    },
  });
  const runs: CrossMediaSeedResult['runs'] = {};
  const readings: CrossMediaReading[] = [];
  try {
    for (const provider of ['bangumi', 'vndb'] as const) {
      const registration = createSourceRegistration(provider, {
        source: crossMediaAliases[provider],
        converterRevision: entityRevision,
      });
      async function* records() {
        yield* plan.records[provider];
        yield* plan.entities[provider];
      }
      const run = await importer.runRecords(registration, records());
      ensure(run.status === 'committed', `Cross-media ${provider} import failed: ${run.status}`);
      runs[provider] = run;
    }
    const graph = new CrossMediaGraph(importer.session.store.database);
    graph.remember(plan.edges);
    const delivered = await graph.deliver({
      claim: (owner) => importer.session.bindings.claim(owner),
      batch: (request) => port.batch(request),
    });
    const keys = [...plan.records.bangumi, ...plan.entities.bangumi, ...plan.records.vndb, ...plan.entities.vndb];
    for (const record of keys) {
      const provider: Provider = record.source === 'vndb' ? 'vndb' : 'bangumi';
      const alias = crossMediaAliases[provider];
      const claim = importer.session.bindings.claim({ source: alias, external_id: record.key });
      if (claim?.state !== 'bound') continue;
      const subject = await port.readReviewedSubject(claim.subject);
      readings.push({
        source: provider,
        externalId: record.key,
        subject,
        route: subjectRoute(subject),
        selection: 'selected',
      });
    }
    const unresolved = delivered.unresolved.map((edge) => ({
      holder: edge.holder,
      target: edge.target,
      property: edge.property,
      reason: edge.reason,
    }));
    return {
      status: plan.gaps.length || unresolved.length ? ('imported-with-gaps' as const) : ('imported' as const),
      franchises: plan.franchises,
      members: plan.members,
      runs,
      readings,
      gaps: plan.gaps,
      unresolved,
    };
  } finally {
    await importer.close();
  }
}

export async function runCrossMediaSeedCli(argv: readonly string[]): Promise<void> {
  const flags = [
    '--bangumi',
    '--vndb',
    '--state',
    '--result',
    '--api',
    '--auth',
    '--account-key',
    '--account',
    '--client',
  ];
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(
      `Usage: bun scripts/datasets/cross-media-seed.ts ${flags.map((flag) => `${flag} <value>`).join(' ')}\n`,
    );
    return;
  }
  ensure(argv.length === flags.length * 2, 'Expected explicit cross-media seed configuration');
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!,
      value = argv[i + 1]!;
    ensure(
      flags.includes(flag) && !values.has(flag) && value && value.length <= 4096 && !value.includes('\0'),
      'Invalid seed option',
    );
    values.set(flag, value);
  }
  const origin = (flag: string) => {
    const url = new URL(values.get(flag)!);
    ensure(
      url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
      'Seed API and Auth require HTTPS origins',
    );
    return url.origin;
  };
  const api = origin('--api'),
    auth = origin('--auth');
  const input = new CrossMediaDumpFiles(values.get('--bangumi')!, values.get('--vndb')!);
  const plan = await planCrossMediaSeed(input);
  const tokenProvider = await createAccountTokenProvider({
    accountKeyPath: values.get('--account-key')!,
    account: values.get('--account')!,
    client: values.get('--client')!,
    authOrigin: auth,
    scopes: [...VNDB_IMPORTER_SCOPES, 'subject:read'],
  });
  const resultPath = resolve(values.get('--result')!);
  const statePath = resolve(values.get('--state')!);
  ensure(
    resultPath !== statePath && ![`${statePath}-wal`, `${statePath}-shm`].includes(resultPath),
    'Result must not overwrite importer state',
  );
  await mkdir(dirname(statePath), { recursive: true });
  const result = await seedCrossMedia(plan, statePath, createImportTransport({ origin: api, tokenProvider }), {
    origin: api,
  });
  await mkdir(dirname(resultPath), { recursive: true });
  await writeFile(
    resultPath,
    `${JSON.stringify({ ...result, sourceDigests: Object.fromEntries(input.digests) }, null, 2)}\n`,
  );
  process.stdout.write(
    `Imported ${result.readings.length} records; ${result.gaps.length} source gaps. Result: ${resultPath}\n`,
  );
}
