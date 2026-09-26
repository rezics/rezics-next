import { createHash } from 'node:crypto';
import type { FieldDisposition } from './field-schema.ts';

/** Offline Kana concept fixture profile. The API's explicit field selection is part of the capture contract. */
export const VNDB_CONCEPT_MAP = 'vndb-concept-map-v1';
export const VNDB_CONCEPT_FIELDS = {
  vn: 'id,tags{id,name,rating,spoiler,lie}',
  character: 'name,traits{id,name,group_id,group_name,spoiler,lie},vns{id,release{id},role,spoiler}',
  tag: 'name,description,category',
  trait: 'name,description,group_id,group_name',
} as const;

export class VndbConceptInvalid extends Error {}
type Kind = keyof typeof VNDB_CONCEPT_FIELDS;
type Capture = { kind: Kind; bytes: Buffer; digest: string; complete: boolean };
type SourceConcept = { sourceId: string; kind: 'tag' | 'trait'; label: string; definition: string | null;
  display: string; group: { sourceId: string; label: string } | null; captureDigest: string };
type SourceClaim = { key: string; subject: string; concept: string | null; unresolved: string | null;
  occurrence: number; kind: 'tag' | 'trait' | 'appearance'; relatedVn: string | null; release: string | null;
  role: string | null; spoiler: number; lie: boolean | null; score: number | null;
  disposition: FieldDisposition; captureDigest: string };

export interface VndbConceptProjection {
  profile: 'vndb-concept-source-projection-v1';
  mappingRevision: typeof VNDB_CONCEPT_MAP;
  concepts: SourceConcept[];
  claims: SourceClaim[];
  fieldInventory: Array<{ grain: Kind; field: string; disposition: FieldDisposition; reason: string }>;
  nativeCandidates: Array<{ sourceId: string; target: string; condition: string }>;
  nativeClaims: Array<{ sourceOccurrence: string; target: string; sourceSubject: string;
    sourceConcept: string | null; relatedVn: string | null; release: string | null; role: string | null;
    spoiler: number; score: number | null; lie: boolean | null; condition: string }>;
  exportDisposition: { status: 'unsupported'; residual: string };
}

const id = (prefix: string, value: unknown) => typeof value === 'string'
  && new RegExp(`^${prefix}[1-9][0-9]{0,11}$`).test(value);
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 500;
const spoiler = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const sourceId = (kind: 'tag' | 'trait', value: string) => `vndb:${kind}:${value}`;

/** A missing or malformed elected surface cannot become an empty qualified result. */
export function projectVndbConceptCaptures(captures: readonly Capture[]): VndbConceptProjection {
  if (captures.length !== 4 || new Set(captures.map(capture => capture.kind)).size !== 4
    || captures.some(capture => !capture.complete || capture.bytes.length > 65_536
      || digest(capture.bytes) !== capture.digest)) throw new VndbConceptInvalid('incomplete capture set');
  const bodies = new Map<Kind, Record<string, unknown>>();
  const captureDigests = new Map<Kind, string>();
  for (const capture of captures) {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capture.bytes)); }
    catch { throw new VndbConceptInvalid('malformed captured JSON'); }
    const body = object(parsed);
    if (!body || !Array.isArray(body.results) || body.results.length > 100 || body.more !== false) {
      throw new VndbConceptInvalid('unbounded or malformed Kana result');
    }
    bodies.set(capture.kind, body);
    captureDigests.set(capture.kind, capture.digest);
  }
  const rows = (kind: Kind) => bodies.get(kind)!.results as unknown[];
  const concepts: SourceConcept[] = [];
  for (const kind of ['tag', 'trait'] as const) for (const rowValue of rows(kind)) {
    const row = object(rowValue);
    if (!row || !id(kind === 'tag' ? 'g' : 'i', row.id) || !string(row.name)
      || (row.description !== undefined && row.description !== null && !string(row.description))) {
      throw new VndbConceptInvalid('invalid provider concept');
    }
    const group = kind === 'trait' && id('i', row.group_id) && string(row.group_name)
      ? { sourceId: sourceId('trait', row.group_id as string), label: row.group_name as string } : null;
    if (kind === 'trait' && !group) throw new VndbConceptInvalid('trait group is missing');
    concepts.push({ sourceId: sourceId(kind, row.id as string), kind, label: row.name as string,
      definition: typeof row.description === 'string' ? row.description : null,
      display: group ? `${group.label} / ${row.name}` : row.name as string, group,
      captureDigest: captureDigests.get(kind)! });
  }
  if (new Set(concepts.map(concept => concept.sourceId)).size !== concepts.length) {
    throw new VndbConceptInvalid('duplicate provider concept');
  }
  const known = new Set(concepts.map(concept => concept.sourceId));
  const knownVns = new Set(rows('vn').map(row => `vndb:vn:${object(row)?.id}`));
  const claims: SourceClaim[] = [];
  const ordinals = new Map<string, number>();
  const push = (claim: Omit<SourceClaim, 'key' | 'occurrence' | 'disposition'>) => {
    const family = `${claim.subject}/${claim.kind}`;
    const occurrence = ordinals.get(family) ?? 0;
    ordinals.set(family, occurrence + 1);
    const target = claim.concept && known.has(claim.concept) ? claim.concept : null;
    const key = createHash('sha256').update(JSON.stringify([claim.captureDigest, family, occurrence]))
      .digest('hex');
    const native = Boolean(target || (claim.kind === 'appearance' && claim.relatedVn
      && knownVns.has(claim.relatedVn)));
    claims.push({ ...claim, concept: target,
      unresolved: native ? null : claim.concept ?? claim.relatedVn,
      key: `urn:rezics:source-occurrence:${key}`, occurrence,
      disposition: native ? 'native' : 'structured-source-only' });
  };
  for (const raw of rows('vn')) {
    const row = object(raw);
    if (!row || !id('v', row.id) || !Array.isArray(row.tags) || row.tags.length > 100) {
      throw new VndbConceptInvalid('invalid VN tag surface');
    }
    for (const value of row.tags) {
      const tag = object(value);
      if (!tag || !id('g', tag.id) || !spoiler(tag.spoiler) || typeof tag.lie !== 'boolean'
        || typeof tag.rating !== 'number' || !(tag.rating > 0 && tag.rating <= 3)) {
        throw new VndbConceptInvalid('invalid tag association');
      }
      push({ subject: `vndb:vn:${row.id}`, concept: sourceId('tag', tag.id as string), unresolved: null,
        kind: 'tag', relatedVn: null, release: null, role: null, spoiler: tag.spoiler as number,
        lie: tag.lie as boolean, score: tag.rating as number, captureDigest: captureDigests.get('vn')! });
    }
  }
  for (const raw of rows('character')) {
    const row = object(raw);
    if (!row || !id('c', row.id) || !Array.isArray(row.traits) || row.traits.length > 100
      || !Array.isArray(row.vns) || row.vns.length > 100) {
      throw new VndbConceptInvalid('invalid character surface');
    }
    const subject = `vndb:character:${row.id}`;
    for (const value of row.traits) {
      const trait = object(value);
      if (!trait || !id('i', trait.id) || !spoiler(trait.spoiler) || typeof trait.lie !== 'boolean') {
        throw new VndbConceptInvalid('invalid trait association');
      }
      push({ subject, concept: sourceId('trait', trait.id as string), unresolved: null,
        kind: 'trait', relatedVn: null, release: null, role: null, spoiler: trait.spoiler as number,
        lie: trait.lie as boolean, score: null, captureDigest: captureDigests.get('character')! });
    }
    for (const value of row.vns) {
      const appearance = object(value);
      const release = object(appearance?.release);
      if (!appearance || !id('v', appearance.id) || !spoiler(appearance.spoiler)
        || !['main', 'primary', 'side', 'appears'].includes(String(appearance.role))
        || (appearance.release !== null && (!release || !id('r', release.id)))) {
        throw new VndbConceptInvalid('invalid character appearance');
      }
      push({ subject, concept: null, unresolved: null, kind: 'appearance',
        relatedVn: `vndb:vn:${appearance.id}`,
        release: release ? `vndb:release:${release.id}` : null, role: appearance.role as string,
        spoiler: appearance.spoiler as number, lie: null, score: null,
        captureDigest: captureDigests.get('character')! });
    }
  }
  const dispositions: Record<Kind, Record<string, [FieldDisposition, string]>> = {
    vn: { id: ['structured-source-only', 'Provider identity is not a native Work identity'],
      tags: ['structured-source-only', 'Association occurrences retain source qualifiers'],
      'tags.id': ['native', 'Source tag claim is a candidate for explicit native Statement acceptance'],
      'tags.name': ['structured-source-only', 'Label does not determine concept identity'],
      'tags.rating': ['structured-source-only', 'Provider tag score is never a native ballot'],
      'tags.spoiler': ['structured-source-only', 'Spoiler qualifies this source association'],
      'tags.lie': ['structured-source-only', 'Source lie flag qualifies this association'] },
    character: { id: ['structured-source-only', 'Provider identity is not a native Character identity'],
      name: ['structured-source-only', 'Source name is not an accepted native NameRecord'],
      traits: ['structured-source-only', 'Trait occurrences retain source qualifiers'],
      'traits.id': ['native', 'Qualified trait claim requires explicit native Statement acceptance'],
      'traits.name': ['structured-source-only', 'Label does not determine concept identity'],
      'traits.group_id': ['structured-source-only', 'Provider group identity is retained'],
      'traits.group_name': ['structured-source-only', 'Group-qualified display is retained'],
      'traits.spoiler': ['structured-source-only', 'Spoiler qualifies this source association'],
      'traits.lie': ['structured-source-only', 'Source lie flag qualifies this association'],
      vns: ['structured-source-only', 'Appearance occurrences retain source qualifiers'],
      'vns.id': ['native', 'Appearance requires an exact native association command'],
      'vns.release': ['structured-source-only', 'Release scope is retained'],
      'vns.release.id': ['native', 'Release-specific appearance requires exact release identity'],
      'vns.role': ['structured-source-only', 'Source role is not an inferred FemaleLead meaning'],
      'vns.spoiler': ['structured-source-only', 'Spoiler qualifies this release appearance'] },
    tag: { id: ['structured-source-only', 'Provider concept identity is retained'],
      name: ['native', 'Native concept requires an explicit reviewed definition'],
      description: ['structured-source-only', 'Source definition is retained with provenance'],
      category: ['structured-source-only', 'Provider category is source-scoped'] },
    trait: { id: ['structured-source-only', 'Provider concept identity is retained'],
      name: ['native', 'Native concept requires an explicit reviewed definition'],
      description: ['structured-source-only', 'Source definition is retained with provenance'],
      group_id: ['structured-source-only', 'Provider group identity is retained'],
      group_name: ['structured-source-only', 'Group-qualified display is retained'] },
  };
  const fieldInventory = ([...bodies.keys()] as Kind[]).flatMap(grain => {
    const fields = new Set<string>();
    const walk = (value: unknown, prefix = '', depth = 0): void => {
      if (depth > 4) throw new VndbConceptInvalid('field nesting exceeds the profile');
      if (Array.isArray(value)) { for (const item of value) walk(item, prefix, depth + 1); return; }
      const record = object(value);
      if (!record) return;
      for (const [field, item] of Object.entries(record)) {
        const path = prefix ? `${prefix}.${field}` : field;
        fields.add(path);
        walk(item, path, depth + 1);
      }
    };
    for (const row of rows(grain)) walk(row);
    return [...fields].sort().map(field => ({ grain, field,
      disposition: dispositions[grain][field]?.[0] ?? 'unsupported' as FieldDisposition,
      reason: dispositions[grain][field]?.[1] ?? 'undeclared-field' }));
  });
  return { profile: 'vndb-concept-source-projection-v1', mappingRevision: VNDB_CONCEPT_MAP,
    concepts, claims, fieldInventory,
    nativeCandidates: concepts.map(concept => ({ sourceId: concept.sourceId,
      target: 'classification-proposition-v1#concept',
      condition: 'reviewed definition and explicit native command' })),
    nativeClaims: claims.filter(claim => claim.disposition === 'native').map(claim => ({
      sourceOccurrence: claim.key, target: claim.kind === 'appearance'
        ? 'statement-v1#appearance' : 'statement-v1#classification',
      sourceSubject: claim.subject, sourceConcept: claim.concept, relatedVn: claim.relatedVn,
      release: claim.release, role: claim.role, spoiler: claim.spoiler, score: claim.score,
      lie: claim.lie, condition: 'exact native identities, definition and separate acceptance required',
    })),
    exportDisposition: { status: 'unsupported', residual:
      'Exact qualified Statement and Context export awaits an export-owner template.' } };
}

/** Source withdrawal affects only that exact support; conjunctive claims retain separate support. */
export function survivingVndbClaims(claims: readonly SourceClaim[], withdrawn: ReadonlySet<string>): SourceClaim[] {
  return claims.filter(claim => !withdrawn.has(claim.key));
}

/** The trait and appearance remain separate accepted inputs to any later conjunction. */
export function sameCharacterTraitAppearance(claims: readonly SourceClaim[], character: string,
  trait: string, release: string): { trait: string; appearance: string } | null {
  const source = claims.filter(claim => claim.subject === character);
  const traitClaim = source.find(claim => claim.kind === 'trait' && claim.concept === trait);
  const appearance = source.find(claim => claim.kind === 'appearance' && claim.release === release);
  return traitClaim && appearance ? { trait: traitClaim.key, appearance: appearance.key } : null;
}
