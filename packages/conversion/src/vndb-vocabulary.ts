import { createHash } from 'node:crypto';
import { mapSourceEnumeration, vndbProducerParentEnds } from './cross-media-entities.ts';
import {
  createMappingEnvironment,
  finishMapping,
  type MappingEnvironment,
  type NativeIdentity,
  type ResolvedConcept,
  type SourceVocabularyInput,
  type SourceVocabularyResult,
  type VndbVocabularyRow,
} from './source-vocabulary.ts';
import {
  vndbReleaseMediumCodes,
  vndbReleaseMediumSchemeUri,
  vndbReleaseMediumTaxonomy,
  vndbReleasePlatformSchemeUri,
  vndbReleasePlatformTaxonomy,
} from './support.ts';

export const vndbVocabularyRevision = 'vndb-vocabulary@4';
const calendarModel = 'http://www.wikidata.org/entity/Q1985727';
const developmentStatus = new Map<number, string>([
  [0, 'Finished'],
  [1, 'In development'],
  [2, 'Cancelled'],
]);
const creditProperties: Readonly<Record<string, string>> = {
  scenario: 'schema:author',
  chardesign: 'schema:illustrator',
  art: 'schema:illustrator',
  music: 'schema:musicBy',
  songs: 'schema:musicBy',
  director: 'schema:director',
  translator: 'schema:translator',
  editor: 'schema:contributor',
  qa: 'schema:contributor',
  staff: 'schema:contributor',
};
const releaseTypes = new Set(['complete', 'partial', 'trial']);
export const vndbAppearanceRoleCodes = Object.freeze(['main', 'primary', 'side', 'appears'] as const);
const appearanceRoles = new Set<string>(vndbAppearanceRoleCodes);
export const vndbAppearanceRoleSchemeUri = 'https://rezics.com/schemes/vndb/character-roles';
export const vndbCharacterBloodTypeSchemeUri = 'https://rezics.com/schemes/vndb/character-blood-types';
export const vndbCharacterBloodTypeTaxonomy = 'vndb.character-blood-type';

function conceptIdentity(value: ResolvedConcept): NativeIdentity {
  return { id: value.id, type: value.type, releaseDigest: value.releaseDigest };
}
function spoilerQualifier(value: number) {
  return { property: 'rezics:spoilerLevel', content: { amount: `+${value}`, unit: '1' } };
}
function dateValue(value: string): { time: string; precision: 9 | 10 | 11; calendarmodel: string } | null {
  if (value.startsWith('0000')) return null;
  if (/^[0-9]{4}$/u.test(value))
    return { time: `+${value}-00-00T00:00:00Z`, precision: 9, calendarmodel: calendarModel };
  if (/^[0-9]{4}-[0-9]{2}$/u.test(value)) {
    const month = Number(value.slice(5));
    if (month < 1 || month > 12) return null;
    return { time: `+${value}-00T00:00:00Z`, precision: 10, calendarmodel: calendarModel };
  }
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    return { time: `+${value}T00:00:00Z`, precision: 11, calendarmodel: calendarModel };
  }
  return null;
}
function rowGap(
  environment: MappingEnvironment,
  row: VndbVocabularyRow,
  reason: Parameters<MappingEnvironment['pushGap']>[0]['reason'],
  property?: string,
  code?: string,
  endpoint?: string,
) {
  environment.pushGap({
    path: environment.sourcePath(row.path) ?? '/sourceVocabulary/rows',
    reason,
    ...(code === undefined ? {} : { code }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(property === undefined ? {} : { property }),
  });
}
function exactConcept(
  environment: MappingEnvironment,
  taxonomy: string,
  code: string,
  path: string,
  expectedScheme?: string,
): ResolvedConcept | null {
  if (expectedScheme) {
    const scheme = environment.input.bindings.schemes.find((item) => item.taxonomy === taxonomy);
    if (scheme && scheme.uri !== expectedScheme) {
      environment.pushGap({ path, code, reason: 'missing_scheme', property: expectedScheme });
      return null;
    }
  }
  return environment.concept(taxonomy, code, path);
}

function mapRow(environment: MappingEnvironment, row: VndbVocabularyRow): void {
  const path = environment.sourcePath(row.path);
  if (!path) {
    rowGap(environment, row, 'invalid_row');
    return;
  }
  switch (row.kind) {
    case 'release-platform':
    case 'release-medium': {
      const code = environment.sourceCode(row.code);
      const platform = row.kind === 'release-platform';
      const property = platform ? 'schema:gamePlatform' : 'wdt:P437';
      if (code === null) {
        rowGap(
          environment,
          row,
          'invalid_source_value',
          platform ? 'releases_platforms.platform' : 'releases_media.medium',
        );
        return;
      }
      const admitted = platform
        ? (() => {
            const mapping = mapSourceEnumeration('vndb', 'platform', code);
            return mapping?.term === property;
          })()
        : vndbReleaseMediumCodes.has(code);
      if (!admitted) {
        rowGap(
          environment,
          row,
          'unknown_code',
          platform ? 'releases_platforms.platform' : 'releases_media.medium',
          code ?? undefined,
        );
        return;
      }
      const taxonomy = platform ? vndbReleasePlatformTaxonomy : vndbReleaseMediumTaxonomy;
      const schemeUri = platform ? vndbReleasePlatformSchemeUri : vndbReleaseMediumSchemeUri;
      const resolved = exactConcept(environment, taxonomy, code, path, schemeUri);
      if (resolved)
        environment.propose({
          row,
          subject: row.release,
          property,
          content: resolved.id,
          target: conceptIdentity(resolved),
          mappingRevision: `${row.kind}@1:${code}`,
        });
      return;
    }
    case 'release-date': {
      if (row.value === null) {
        rowGap(environment, row, 'unsupported_source_case', 'schema:datePublished', 'absent');
        return;
      }
      if (row.value === 'TBA' || row.value === 'unknown') {
        const code = row.value;
        if (!environment.admit(row.release, 'schema:keywords', path, code)) return;
        const resolved = exactConcept(environment, 'vndb.releases.released', code, path);
        if (resolved)
          environment.propose({
            row,
            subject: row.release,
            property: 'schema:keywords',
            content: resolved.id,
            target: conceptIdentity(resolved),
            mappingRevision: 'release-state@1',
          });
        return;
      }
      if (typeof row.value !== 'string') {
        rowGap(environment, row, 'invalid_source_value', 'schema:datePublished');
        return;
      }
      const date = dateValue(row.value);
      if (!date) {
        rowGap(environment, row, 'invalid_source_value', 'schema:datePublished');
        return;
      }
      environment.propose({
        row,
        subject: row.release,
        property: 'schema:datePublished',
        content: date,
        mappingRevision: 'release-date@1',
      });
      return;
    }
    case 'development-status': {
      const code = environment.sourceCode(row.code);
      if (!code || !developmentStatus.has(row.code)) {
        rowGap(environment, row, 'unknown_code', 'vn.devstatus', code ?? undefined);
        return;
      }
      const resolved = exactConcept(environment, 'vndb.development-status', code, path);
      if (resolved)
        environment.propose({
          row,
          subject: row.subject,
          property: 'schema:keywords',
          content: resolved.id,
          target: conceptIdentity(resolved),
          mappingRevision: 'development-status@1',
        });
      return;
    }
    case 'release-supersedes': {
      const endpoint = environment.sourceCode(row.endpointCode);
      if (!row.endpoint) {
        rowGap(environment, row, 'missing_identity', 'wdt:P155', endpoint ?? undefined, endpoint ?? undefined);
        return;
      }
      environment.propose({
        row,
        subject: row.release,
        property: 'wdt:P155',
        content: '',
        target: row.endpoint,
        sourceEndpoint: row.endpointCode,
        mappingRevision: 'release-supersedes@1',
      });
      return;
    }
    case 'release-work': {
      const code = environment.sourceCode(row.completenessCode);
      if (!code || !releaseTypes.has(code))
        rowGap(environment, row, 'unknown_code', 'releases_vn.rtype', code ?? undefined);
      else rowGap(environment, row, 'qualifier_not_admitted', 'wdt:P31', code);
      if (!row.work) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'schema:exampleOfWork',
          environment.sourceCode(row.workCode) ?? undefined,
          environment.sourceCode(row.workCode) ?? undefined,
        );
        return;
      }
      environment.propose({
        row,
        subject: row.release,
        property: 'schema:exampleOfWork',
        content: '',
        target: row.work,
        sourceEndpoint: row.workCode,
        mappingRevision: 'release-work@1',
      });
      return;
    }
    case 'staff': {
      const code = environment.sourceCode(row.roleCode);
      const property = code === null ? undefined : creditProperties[code];
      if (code === null || !property) {
        rowGap(environment, row, 'unknown_code', 'vn_staff.role', code ?? undefined);
        return;
      }
      if (!row.holder) {
        rowGap(
          environment,
          row,
          'missing_identity',
          property,
          environment.sourceCode(row.holderCode) ?? undefined,
          environment.sourceCode(row.holderCode) ?? undefined,
        );
        return;
      }
      if (row.holder.type !== 'schema:Person') {
        environment.pushGap({
          path,
          code,
          endpoint: environment.sourceCode(row.holderCode) ?? undefined,
          reason: 'incompatible_identity',
          property,
          requiredProfile: row.holder.type,
        });
        return;
      }
      const resolved = exactConcept(environment, 'vndb.credit_type', code, path);
      if (!resolved) return;
      const qualifiers: { property: string; content: unknown; identity?: NativeIdentity }[] = [
        { property: 'wdt:P3831', content: resolved.id, identity: conceptIdentity(resolved) },
      ];
      if (row.creditedAs !== undefined) {
        if (
          typeof row.creditedAs !== 'string' ||
          !row.creditedAs.isWellFormed() ||
          !row.creditedAs.trim() ||
          row.creditedAs.length > 1500
        ) {
          rowGap(environment, row, 'invalid_source_value', 'wdt:P1932', code);
          return;
        }
        qualifiers.push({ property: 'wdt:P1932', content: row.creditedAs });
      }
      environment.propose({
        row,
        subject: row.subject,
        property,
        content: '',
        target: row.holder,
        sourceEndpoint: row.holderCode,
        qualifiers,
        mappingRevision: 'staff-role@1',
      });
      return;
    }
    case 'voice-credit': {
      const performer = row.performer;
      if (!performer) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'wdt:P725',
          environment.sourceCode(row.performerCode) ?? undefined,
          environment.sourceCode(row.performerCode) ?? undefined,
        );
        return;
      }
      if (performer.type !== 'schema:Person' || !environment.identityId(performer)) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.performerCode) ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P725',
          requiredProfile: performer.type,
        });
        return;
      }
      const character = row.character;
      if (!character) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'wdt:P453',
          environment.sourceCode(row.characterCode) ?? undefined,
          environment.sourceCode(row.characterCode) ?? undefined,
        );
        return;
      }
      const characterId = environment.identityId(character);
      if (!characterId) {
        environment.pushGap({
          path,
          endpoint: environment.sourceCode(row.characterCode) ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P453',
          requiredProfile: character.type,
        });
        return;
      }
      const qualifiers: { property: string; content: unknown; identity?: NativeIdentity }[] = [
        { property: 'wdt:P453', content: characterId, identity: character },
      ];
      if (row.creditedAs !== undefined) {
        if (
          typeof row.creditedAs !== 'string' ||
          !row.creditedAs.isWellFormed() ||
          !row.creditedAs.trim() ||
          row.creditedAs.length > 1500
        ) {
          rowGap(environment, row, 'invalid_source_value', 'wdt:P1932');
          return;
        }
        qualifiers.push({ property: 'wdt:P1932', content: row.creditedAs });
      }
      environment.propose({
        row,
        subject: row.subject,
        property: 'wdt:P725',
        content: '',
        target: performer,
        sourceEndpoint: row.performerCode,
        qualifiers,
        mappingRevision: 'voice-credit@1',
      });
      return;
    }
    case 'tag': {
      const code = environment.sourceCode(row.code);
      if (!code) {
        rowGap(environment, row, 'invalid_source_value', 'tags_vn.tag');
        return;
      }
      if (!Number.isInteger(row.spoiler) || row.spoiler < 0 || row.spoiler > 2) {
        rowGap(environment, row, 'invalid_source_value', 'rezics:spoilerLevel', code);
        return;
      }
      if (row.category !== 'cont' && row.category !== 'ero' && row.category !== 'tech') {
        rowGap(environment, row, 'unknown_code', 'tags.category');
        return;
      }
      const resolved = exactConcept(environment, `vndb.tag.${row.category}`, code, path);
      if (resolved)
        environment.propose({
          row,
          subject: row.subject,
          property: 'schema:genre',
          content: resolved.id,
          target: conceptIdentity(resolved),
          qualifiers: [spoilerQualifier(row.spoiler)],
          mappingRevision: 'tag@1',
        });
      return;
    }
    case 'tag-weight': {
      const tagCode = environment.sourceCode(row.tagId);
      if (!tagCode || !/^g[1-9][0-9]{0,9}$/u.test(tagCode)) {
        rowGap(environment, row, 'invalid_source_value', 'rezics:sourceTagWeight');
        return;
      }
      if (row.category !== 'cont' && row.category !== 'ero' && row.category !== 'tech') {
        rowGap(environment, row, 'unknown_code', 'tags.category');
        return;
      }
      const resolved = exactConcept(environment, `vndb.tag.${row.category}`, tagCode, path);
      if (!resolved) return;
      const result = produceVndbSourceTagWeightCandidate({
        endpoint: row.endpoint as typeof vndbTagsRatingEndpoint,
        requestBody: row.requestBody,
        snapshot: row.snapshot,
        subjectId: row.subject.id,
        contextId: row.contextId,
        property: 'schema:genre',
        conceptId: resolved.id,
        subjectRecordId: row.subjectRecordId,
        tagId: tagCode,
      });
      if (result.state !== 'available') {
        rowGap(environment, row, 'unsupported_source_case', 'rezics:sourceTagWeight', result.state);
        return;
      }
      environment.propose({
        row,
        subject: row.subject,
        property: result.candidate.statement.property.id,
        content: resolved.id,
        target: conceptIdentity(resolved),
        qualifiers: result.candidate.statement.qualifiers.map((term) => ({
          property: term.property.id,
          content: term.value.content,
        })),
        references: result.candidate.statement.references,
        mappingRevision: 'tag-weight@1',
      });
      return;
    }
    case 'character-trait': {
      const code = environment.sourceCode(row.code);
      if (!code) {
        rowGap(environment, row, 'invalid_source_value', 'chars_traits.tid');
        return;
      }
      if (!Number.isInteger(row.spoiler) || row.spoiler < 0 || row.spoiler > 2) {
        rowGap(environment, row, 'invalid_source_value', 'rezics:spoilerLevel', code);
        return;
      }
      if (row.lie !== undefined && typeof row.lie !== 'boolean') {
        rowGap(environment, row, 'invalid_source_value', 'chars_traits.lie', code);
        return;
      }
      if (row.lie === true) {
        rowGap(environment, row, 'unsupported_source_case', 'chars_traits.lie', code);
        return;
      }
      const resolved = exactConcept(environment, 'vndb.character-trait', code, path);
      if (resolved)
        environment.propose({
          row,
          subject: row.character,
          property: 'schema:keywords',
          content: resolved.id,
          target: conceptIdentity(resolved),
          qualifiers: [spoilerQualifier(row.spoiler)],
          mappingRevision: 'character-trait@1',
        });
      return;
    }
    case 'character-blood-type': {
      const code = environment.sourceCode(row.code);
      if (row.omission === 'missing_source_value') {
        rowGap(environment, row, 'unsupported_source_case', 'chars.bloodt', 'missing');
        return;
      }
      if (row.omission === 'invalid_source_value' || code === null) {
        rowGap(environment, row, 'invalid_source_value', 'chars.bloodt');
        return;
      }
      if (code === 'unknown') {
        rowGap(environment, row, 'unsupported_source_case', 'chars.bloodt', code);
        return;
      }
      if (!['a', 'b', 'ab', 'o'].includes(code)) {
        rowGap(environment, row, 'unknown_code', 'chars.bloodt', code);
        return;
      }
      const resolved = exactConcept(
        environment,
        vndbCharacterBloodTypeTaxonomy,
        code,
        path,
        vndbCharacterBloodTypeSchemeUri,
      );
      if (resolved)
        environment.propose({
          row,
          subject: row.character,
          property: 'wdt:P1853',
          content: resolved.id,
          target: conceptIdentity(resolved),
          mappingRevision: `character-blood-type@1:${code}`,
        });
      return;
    }
    case 'character-appearance': {
      const role = environment.sourceCode(row.roleCode);
      if (!role || !appearanceRoles.has(role)) {
        rowGap(environment, row, 'unknown_code', 'chars_vns.role', role ?? undefined);
        return;
      }
      if (!Number.isInteger(row.spoiler) || row.spoiler < 0 || row.spoiler > 2) {
        rowGap(environment, row, 'invalid_source_value', 'rezics:spoilerLevel', role);
        return;
      }
      const release =
        row.releaseCode === undefined || row.releaseCode === null ? null : environment.sourceCode(row.releaseCode);
      if (row.releaseCode !== undefined && row.releaseCode !== null && !release) {
        rowGap(environment, row, 'invalid_source_value', 'chars_vns.rid');
        return;
      }
      if (release) {
        rowGap(environment, row, 'unsupported_source_case', 'chars_vns.rid', release);
        return;
      }
      if (!row.character) {
        rowGap(
          environment,
          row,
          'missing_identity',
          'schema:character',
          environment.sourceCode(row.characterCode) ?? undefined,
          environment.sourceCode(row.characterCode) ?? undefined,
        );
        return;
      }
      const resolved = exactConcept(environment, 'vndb.char_role', role, path, vndbAppearanceRoleSchemeUri);
      if (resolved)
        environment.propose({
          row,
          subject: row.subject,
          property: 'schema:character',
          content: '',
          target: row.character,
          sourceEndpoint: row.characterCode,
          qualifiers: [
            { property: 'wdt:P3831', content: resolved.id, identity: conceptIdentity(resolved) },
            spoilerQualifier(row.spoiler),
          ],
          mappingRevision: 'appearance-role@1',
        });
      return;
    }
    case 'producer-parent': {
      const code = environment.sourceCode(row.code);
      if (code !== 'par' && code !== 'sub') {
        rowGap(environment, row, 'unknown_code', 'producers_relations.relation', code ?? undefined);
        return;
      }
      const endpointCode = environment.sourceCode(row.endpointCode);
      if (!row.endpoint) {
        rowGap(environment, row, 'missing_identity', 'wdt:P749', code, endpointCode ?? undefined);
        return;
      }
      const orientation = vndbProducerParentEnds(code, row.subject.id, row.endpoint.id);
      if (!orientation) {
        rowGap(environment, row, 'unknown_code', 'producers_relations.relation', code);
        return;
      }
      const child = orientation.holder === row.subject.id ? row.subject : row.endpoint;
      const parent = orientation.target === row.subject.id ? row.subject : row.endpoint;
      if (child.type !== 'schema:Organization' || parent.type !== 'schema:Organization') {
        environment.pushGap({
          path,
          code,
          endpoint: endpointCode ?? undefined,
          reason: 'incompatible_identity',
          property: 'wdt:P749',
          requiredProfile: child.type !== 'schema:Organization' ? child.type : parent.type,
        });
        return;
      }
      environment.propose({
        row,
        subject: child,
        property: 'wdt:P749',
        content: '',
        target: parent,
        sourceEndpoint: row.endpointCode,
        mappingRevision: `producer-parent@1:${code}`,
      });
      return;
    }
  }
}

/** Maps normalized caller-owned VNDB rows and never follows release/work/person endpoints. */
export function mapVndbVocabulary(input: SourceVocabularyInput): SourceVocabularyResult {
  const environment = createMappingEnvironment(input);
  if (environment.input.metadata.provider !== 'vndb') {
    environment.pushGap({ path: '/sourceVocabulary/provider', reason: 'invalid_row' });
    return finishMapping(environment);
  }
  const kinds = [
    'release-date',
    'release-platform',
    'release-medium',
    'development-status',
    'release-supersedes',
    'release-work',
    'staff',
    'voice-credit',
    'tag',
    'tag-weight',
    'character-trait',
    'character-blood-type',
    'character-appearance',
    'producer-parent',
  ];
  for (const row of environment.rows) {
    if (!environment.isRow(row, kinds)) {
      environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
      continue;
    }
    try {
      mapRow(environment, row as VndbVocabularyRow);
    } catch {
      environment.pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
    }
  }
  return finishMapping(environment);
}
export const vndbTagsRatingMetric = 'vndbTagsRating' as const;
export const vndbTagsRatingEndpoint = 'https://api.vndb.org/kana/vn' as const;
export const vndbTagsRatingDocumentation = 'https://api.vndb.org/kana#post-vn' as const;
const sourceId = /^v[1-9][0-9]{0,9}$/u;
const tagId = /^g[1-9][0-9]{0,9}$/u;
const subjectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const snapshotLimit = 1024 * 1024;
const sourceTagWeightItemLimit = 512;

type JsonNumber = Readonly<{ sourceNumber: string }>;
type JsonRecord = { [key: string]: JsonValue; sourceNumber?: never };
type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonRecord;

export type VndbSourceTagWeightInput = Readonly<{
  /** Exact Kana query endpoint that produced the response. */
  endpoint: typeof vndbTagsRatingEndpoint;
  /** Exact UTF-8 body sent to the Kana /vn endpoint for this response. */
  requestBody: Uint8Array | string;
  /** Exact UTF-8 response bytes from that Kana /vn query. */
  snapshot: Uint8Array | string;
  subjectId: string;
  contextId: string;
  property: 'schema:genre' | 'schema:keywords';
  conceptId: string;
  subjectRecordId: string;
  tagId: string;
}>;

export type VndbSourceTagWeightCandidate = Readonly<{
  contextId: string;
  statement: {
    property: { id: 'schema:genre' | 'schema:keywords' };
    value: { type: 'value'; content: string };
    rank: 'normal';
    qualifiers: {
      property: { id: string };
      value: { type: 'value'; content: string | { amount: string; unit: '1' } };
    }[];
    references: { parts: { property: { id: string }; value: { type: 'value'; content: string } }[] }[];
  };
  source: { recordId: string; tagId: string; digest: string; amount: string };
}>;

export type VndbSourceTagWeightResult =
  | { state: 'available'; candidate: VndbSourceTagWeightCandidate }
  | { state: 'absent' }
  | { state: 'empty' }
  | { state: 'suppressed' }
  | { state: 'unsupported' }
  | { state: 'unavailable' };

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('sourceNumber' in value);
}

function isNumber(value: JsonValue | undefined): value is JsonNumber {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'sourceNumber' in value;
}

/** A small bounded JSON reader retains number tokens so a provider decimal is never rounded through Number. */
function parseSnapshot(source: string): JsonValue {
  let cursor = 0;
  const whitespace = () => {
    while (source[cursor] === ' ' || source[cursor] === '\n' || source[cursor] === '\r' || source[cursor] === '\t')
      cursor += 1;
  };
  const string = (): string => {
    const start = cursor;
    cursor += 1;
    while (cursor < source.length) {
      const code = source.charCodeAt(cursor);
      if (code === 34) {
        cursor += 1;
        return JSON.parse(source.slice(start, cursor)) as string;
      }
      if (code < 32) throw new TypeError('Invalid source JSON');
      if (code === 92) cursor += 1;
      cursor += 1;
    }
    throw new TypeError('Invalid source JSON');
  };
  const value = (depth: number): JsonValue => {
    if (depth > 32) throw new TypeError('Invalid source JSON');
    whitespace();
    const current = source[cursor];
    if (current === '"') return string();
    if (current === '{') {
      cursor += 1;
      whitespace();
      const result = Object.create(null) as JsonRecord;
      if (source[cursor] === '}') {
        cursor += 1;
        return result;
      }
      while (cursor < source.length) {
        whitespace();
        if (source[cursor] !== '"') throw new TypeError('Invalid source JSON');
        const key = string();
        if (Object.hasOwn(result, key)) throw new TypeError('Invalid source JSON');
        whitespace();
        if (source[cursor++] !== ':') throw new TypeError('Invalid source JSON');
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === '}') return result;
        if (delimiter !== ',') throw new TypeError('Invalid source JSON');
      }
      throw new TypeError('Invalid source JSON');
    }
    if (current === '[') {
      cursor += 1;
      whitespace();
      const result: JsonValue[] = [];
      if (source[cursor] === ']') {
        cursor += 1;
        return result;
      }
      while (cursor < source.length) {
        result.push(value(depth + 1));
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === ']') return result;
        if (delimiter !== ',') throw new TypeError('Invalid source JSON');
      }
      throw new TypeError('Invalid source JSON');
    }
    if (source.startsWith('true', cursor)) {
      cursor += 4;
      return true;
    }
    if (source.startsWith('false', cursor)) {
      cursor += 5;
      return false;
    }
    if (source.startsWith('null', cursor)) {
      cursor += 4;
      return null;
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(cursor));
    if (!match) throw new TypeError('Invalid source JSON');
    cursor += match[0].length;
    return { sourceNumber: match[0] };
  };
  const result = value(0);
  whitespace();
  if (cursor !== source.length) throw new TypeError('Invalid source JSON');
  return result;
}

function expandDecimal(token: string): string | null {
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(token);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 256) return null;
  const digits = `${match[1]}${fraction}`;
  const scale = fraction.length - exponent;
  const expanded =
    scale <= 0
      ? `${digits}${'0'.repeat(-scale)}`
      : scale >= digits.length
        ? `0.${'0'.repeat(scale - digits.length)}${digits}`
        : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return expanded.length <= 126 ? expanded : null;
}

function positiveAtMostThree(amount: string): boolean {
  if (!/[1-9]/u.test(amount)) return false;
  const [wholeRaw = '0', fraction = ''] = amount.split('.');
  const whole = wholeRaw.replace(/^0+/u, '') || '0';
  if (whole.length > 1 || Number(whole) > 3) return false;
  return whole !== '3' || !/[1-9]/u.test(fraction);
}

function quantity(property: string, amount: string) {
  return { property: { id: property }, value: { type: 'value' as const, content: { amount, unit: '1' as const } } };
}
function literal(property: string, content: string) {
  return { property: { id: property }, value: { type: 'value' as const, content } };
}

/** Map one verified aggregate API record into an ordinary native candidate; this grants no write authority. */
export function produceVndbSourceTagWeightCandidate(input: VndbSourceTagWeightInput): VndbSourceTagWeightResult {
  if (input.property !== 'schema:genre' && input.property !== 'schema:keywords') return { state: 'unsupported' };
  if (input.endpoint !== vndbTagsRatingEndpoint) return { state: 'unavailable' };
  if (
    !subjectId.test(input.subjectId) ||
    !subjectId.test(input.contextId) ||
    !subjectId.test(input.conceptId) ||
    !sourceId.test(input.subjectRecordId)
  )
    return { state: 'unavailable' };
  if (!tagId.test(input.tagId)) return { state: 'unavailable' };
  const requestBytes =
    typeof input.requestBody === 'string' ? new TextEncoder().encode(input.requestBody) : input.requestBody;
  if (requestBytes.byteLength === 0 || requestBytes.byteLength > 2048) return { state: 'unavailable' };
  let request: JsonValue;
  try {
    request = parseSnapshot(new TextDecoder('utf-8', { fatal: true }).decode(requestBytes));
  } catch {
    return { state: 'unavailable' };
  }
  if (
    !isRecord(request) ||
    Object.keys(request).sort().join(',') !== 'fields,filters,results' ||
    request.fields !== 'id,tags{id,rating,spoiler,lie}' ||
    !isNumber(request.results) ||
    request.results.sourceNumber !== '1' ||
    !Array.isArray(request.filters) ||
    request.filters.length !== 3 ||
    request.filters[0] !== 'id' ||
    request.filters[1] !== '=' ||
    request.filters[2] !== input.subjectRecordId
  )
    return { state: 'unavailable' };
  const bytes = typeof input.snapshot === 'string' ? new TextEncoder().encode(input.snapshot) : input.snapshot;
  if (bytes.byteLength === 0 || bytes.byteLength > snapshotLimit) return { state: 'unavailable' };
  let parsed: JsonValue;
  try {
    parsed = parseSnapshot(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { state: 'unavailable' };
  }
  if (!isRecord(parsed) || parsed.more !== false || !Array.isArray(parsed.results) || parsed.results.length !== 1)
    return { state: 'unavailable' };
  const record = parsed.results[0];
  if (
    !isRecord(record) ||
    record.id !== input.subjectRecordId ||
    !Array.isArray(record.tags) ||
    record.tags.length > sourceTagWeightItemLimit
  )
    return { state: 'unavailable' };
  const selected = record.tags.filter((entry) => isRecord(entry) && entry.id === input.tagId);
  if (selected.length === 0) return { state: 'absent' };
  if (selected.length !== 1) return { state: 'unavailable' };
  const tag = selected[0];
  if (!isRecord(tag)) return { state: 'unavailable' };
  if (tag.lie === true) return { state: 'suppressed' };
  if (tag.lie !== false) return { state: 'unavailable' };
  if (tag.rating === null) return { state: 'empty' };
  if (!isNumber(tag.rating) || !isNumber(tag.spoiler)) return { state: 'unavailable' };
  if (!/^(?:0|1|2)$/u.test(tag.spoiler.sourceNumber)) return { state: 'unavailable' };
  const spoiler = Number(tag.spoiler.sourceNumber);
  if (!Number.isInteger(spoiler) || spoiler < 0 || spoiler > 2) return { state: 'unavailable' };
  const parsedRating = Number(tag.rating.sourceNumber);
  const decimal = expandDecimal(tag.rating.sourceNumber);
  if (!Number.isFinite(parsedRating) || parsedRating <= 0 || !decimal || !positiveAtMostThree(decimal))
    return { state: 'unavailable' };

  const digest = createHash('sha256').update(bytes).digest('hex');
  const citation = `https://vndb.org/${input.subjectRecordId}`;
  const statement: VndbSourceTagWeightCandidate['statement'] = {
    property: { id: input.property },
    value: { type: 'value', content: input.conceptId },
    rank: 'normal',
    qualifiers: [
      quantity('rezics:sourceTagWeight', `+${decimal}`),
      literal('rezics:sourceTagWeightMetric', vndbTagsRatingMetric),
      quantity('rezics:spoilerLevel', `+${spoiler}`),
    ],
    references: [
      {
        parts: [
          literal('schema:url', citation),
          literal('rezics:sourceTagId', input.tagId),
          literal('rezics:sourceSnapshot', `unversioned:sha256:${digest}`),
        ],
      },
      { parts: [literal('schema:url', vndbTagsRatingDocumentation)] },
    ],
  };
  return {
    state: 'available',
    candidate: {
      contextId: input.contextId,
      statement,
      source: { recordId: input.subjectRecordId, tagId: input.tagId, digest, amount: decimal },
    },
  };
}
