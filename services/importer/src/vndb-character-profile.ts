import { bundledDigest } from '@rezics/definitions/bundled';
import {
  projectVndbCharacterBloodType,
  vndbCharacterBloodTypeCodes,
  type VndbCharacterBloodTypeCode,
} from '@rezics/conversion/cross-media-entities';
import type { NativeIdentity, SourceVocabularyBindings } from '@rezics/conversion/source-vocabulary';
import { vndbCharacterBloodTypeSchemeUri, vndbCharacterBloodTypeTaxonomy } from '@rezics/conversion/vndb-vocabulary';
import type { ImporterOptions } from './importer.ts';
import type { CrossMediaPlan, CrossMediaPort } from './cross-media-seed.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const characterKey = /^c[1-9][0-9]{0,31}$/u;
const profileCharacterLimit = 256;
const emptyBindings: SourceVocabularyBindings = { releaseDigest: bundledDigest, schemes: [], concepts: [] };

export const vndbCharacterBloodTypeConceptUri = (code: VndbCharacterBloodTypeCode) =>
  `${vndbCharacterBloodTypeSchemeUri}/${code}`;

export type VndbCharacterProfileReferences = Readonly<{
  schemeId: string;
  concepts: readonly { code: VndbCharacterBloodTypeCode; id: string }[];
}>;

export type VndbCharacterProfileRequirement = Readonly<{
  taxonomy: typeof vndbCharacterBloodTypeTaxonomy;
  code: VndbCharacterBloodTypeCode;
  schemeUri: typeof vndbCharacterBloodTypeSchemeUri;
  conceptUri: string;
}>;

export type VndbCharacterProfileOmission = Readonly<{
  externalId: string;
  field: 'bloodt' | 'gender' | 'spoil_gender';
  reason:
    | 'missing_source_value'
    | 'source_unknown'
    | 'unknown_source_code'
    | 'invalid_source_value'
    | 'native_gender_variant_not_admitted';
}>;

type BloodTypeRow = Readonly<{
  code: string | null;
  omission?: 'missing_source_value' | 'invalid_source_value';
}>;

export type VndbCharacterProfilePlan = Readonly<{
  characters: ReadonlyMap<string, BloodTypeRow>;
  requirements: readonly VndbCharacterProfileRequirement[];
  omissions: readonly VndbCharacterProfileOmission[];
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse only the finite source-code-to-native-UUID binding file; public reads establish every association. */
export function parseVndbCharacterProfileReferences(value: unknown): VndbCharacterProfileReferences {
  if (!object(value)) throw new TypeError('Invalid VNDB character profile bindings');
  const schemeId = value.schemeId;
  const rawConcepts = value.concepts;
  if (typeof schemeId !== 'string' || !uuid.test(schemeId) || !Array.isArray(rawConcepts) || rawConcepts.length > 4)
    throw new TypeError('Invalid VNDB character profile scheme bindings');
  const codes = new Set<string>();
  const concepts = rawConcepts.map((raw) => {
    if (!object(raw)) throw new TypeError('Invalid VNDB character profile Concept binding');
    const code = raw.code;
    const id = raw.id;
    if (
      typeof code !== 'string' ||
      !(vndbCharacterBloodTypeCodes as readonly string[]).includes(code) ||
      typeof id !== 'string' ||
      !uuid.test(id) ||
      codes.has(code)
    )
      throw new TypeError('Invalid VNDB character profile Concept binding');
    codes.add(code);
    return { code: code as VndbCharacterBloodTypeCode, id };
  });
  concepts.sort((left, right) => left.code.localeCompare(right.code));
  return { schemeId, concepts };
}

function hasAdoptedContent(read: unknown, property: string, expected: string): boolean {
  if (!object(read) || !object(read.subject) || !object(read.subject.statements)) return false;
  const rows = read.subject.statements[property];
  return Array.isArray(rows) && rows.some((row) => object(row) && object(row.value) && row.value.content === expected);
}

/** Verify exact current public type, URI and scheme associations before a code can be proposed. */
export async function readVndbCharacterProfileBindings(
  port: Pick<CrossMediaPort, 'readReviewedSubject'>,
  known?: VndbCharacterProfileReferences,
): Promise<SourceVocabularyBindings> {
  if (!known) return emptyBindings;
  let schemeRead: unknown;
  try {
    schemeRead = await port.readReviewedSubject(known.schemeId);
  } catch {
    return emptyBindings;
  }
  if (
    !object(schemeRead) ||
    !object(schemeRead.subject) ||
    schemeRead.subject.id !== known.schemeId ||
    schemeRead.subject.type !== 'skos:ConceptScheme' ||
    !hasAdoptedContent(schemeRead, 'schema:url', vndbCharacterBloodTypeSchemeUri)
  )
    return emptyBindings;

  const concepts: SourceVocabularyBindings['concepts'][number][] = [];
  for (const item of known.concepts) {
    let conceptRead: unknown;
    try {
      conceptRead = await port.readReviewedSubject(item.id);
    } catch {
      continue;
    }
    if (
      !object(conceptRead) ||
      !object(conceptRead.subject) ||
      conceptRead.subject.id !== item.id ||
      conceptRead.subject.type !== 'skos:Concept' ||
      !hasAdoptedContent(conceptRead, 'schema:url', vndbCharacterBloodTypeConceptUri(item.code)) ||
      !hasAdoptedContent(conceptRead, 'skos:inScheme', known.schemeId)
    )
      continue;
    concepts.push({
      taxonomy: vndbCharacterBloodTypeTaxonomy,
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
        taxonomy: vndbCharacterBloodTypeTaxonomy,
        id: known.schemeId,
        uri: vndbCharacterBloodTypeSchemeUri,
        type: 'skos:ConceptScheme',
        releaseDigest: bundledDigest,
      },
    ],
    concepts,
  };
}

function sourceCell(value: unknown, present: boolean): BloodTypeRow {
  const projection = projectVndbCharacterBloodType(value, present);
  switch (projection.status) {
    case 'explicit':
      return { code: projection.code };
    case 'unsupported':
      return { code: projection.code };
    case 'unknown':
      return { code: 'unknown' };
    case 'missing':
      return { code: null, omission: 'missing_source_value' };
    case 'malformed':
      return { code: null, omission: 'invalid_source_value' };
  }
}

function omissionReason(value: unknown, present: boolean): VndbCharacterProfileOmission['reason'] | undefined {
  const projection = projectVndbCharacterBloodType(value, present);
  switch (projection.status) {
    case 'explicit':
      return;
    case 'missing':
      return 'missing_source_value';
    case 'unknown':
      return 'source_unknown';
    case 'unsupported':
      return 'unknown_source_code';
    case 'malformed':
      return 'invalid_source_value';
  }
}

/** Project only selected, already bounded VNDB Character identities and their three profile variants. */
export function planVndbCharacterProfile(plan: CrossMediaPlan): VndbCharacterProfilePlan {
  const characters = new Map<string, BloodTypeRow>();
  const requirements = new Map<VndbCharacterBloodTypeCode, VndbCharacterProfileRequirement>();
  const omissions: VndbCharacterProfileOmission[] = [];
  const selected = new Set(
    plan.members
      .filter((member) => member.source === 'vndb' && member.kind === 'character' && member.franchise !== undefined)
      .map((member) => member.key),
  );
  for (const record of plan.entities.vndb) {
    if (
      !selected.has(record.key) ||
      !characterKey.test(record.key) ||
      !object(record.payload) ||
      characters.size >= profileCharacterLimit
    )
      continue;
    const payload = record.payload;
    const present = Object.hasOwn(payload, 'bloodt');
    const bloodt = Object.getOwnPropertyDescriptor(payload, 'bloodt')?.value;
    characters.set(record.key, sourceCell(bloodt, present));
    const reason = omissionReason(bloodt, present);
    if (reason) omissions.push({ externalId: record.key, field: 'bloodt', reason });
    else if (typeof bloodt === 'string') {
      const projection = projectVndbCharacterBloodType(bloodt, true);
      if (projection.status === 'explicit')
        requirements.set(projection.code, {
          taxonomy: vndbCharacterBloodTypeTaxonomy,
          code: projection.code,
          schemeUri: vndbCharacterBloodTypeSchemeUri,
          conceptUri: vndbCharacterBloodTypeConceptUri(projection.code),
        });
    }
    for (const field of ['gender', 'spoil_gender'] as const) {
      if (!Object.hasOwn(payload, field)) continue;
      const value = Object.getOwnPropertyDescriptor(payload, field)?.value;
      if (value === null || value === '' || value === undefined) continue;
      omissions.push({
        externalId: record.key,
        field,
        reason: 'native_gender_variant_not_admitted',
      });
    }
  }
  return {
    characters,
    requirements: [...requirements.values()].sort((left, right) => left.code.localeCompare(right.code)),
    omissions: omissions.slice(0, profileCharacterLimit * 3),
  };
}

/** Join proposals to the current selected Character owner after the ordinary importer resolves its identity. */
export function vndbCharacterProfileAdmission(
  plan: VndbCharacterProfilePlan,
  bindings: SourceVocabularyBindings,
): NonNullable<ImporterOptions['vocabularyAdmission']> {
  return {
    request({ owner, subject }) {
      if (!subject || !characterKey.test(owner.external_id)) return;
      const source = plan.characters.get(owner.external_id);
      if (!source) return;
      const character: NativeIdentity = { id: subject, type: 'wd:Q95074', releaseDigest: bundledDigest };
      return {
        bindings,
        rows: [
          {
            kind: 'character-blood-type',
            path: '/chars/bloodt',
            character,
            code: source.code,
            ...(source.omission ? { omission: source.omission } : {}),
          },
        ],
      };
    },
  };
}
