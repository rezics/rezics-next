import { types as utilTypes } from 'node:util';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import {
  BATCH_LIMIT,
  checkBatchWrite,
  type BatchCommand,
  type BatchReference,
  type BatchStatement,
} from '@rezics/definitions/bulk';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import { commandKey, safeSourceUrl, sourceEnvelope } from './support.ts';

export const sourceVocabularyRevision = 'source-vocabulary@1';
export const sourceVocabularyLimits = Object.freeze({ rows: 64, commands: BATCH_LIMIT, gaps: 64, schemes: 64, concepts: 512 });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export type SourceVocabularyProvider = 'bangumi' | 'vndb';
export type NativeIdentity = Readonly<{
  id: string;
  type: string;
  releaseDigest: string;
}>;
export type ResolvedScheme = Readonly<{
  taxonomy: string;
  id: string;
  uri: string;
  type: 'skos:ConceptScheme';
  releaseDigest: string;
}>;
export type ResolvedConcept = Readonly<{
  taxonomy: string;
  code: string;
  id: string;
  type: 'skos:Concept';
  schemeId: string;
  releaseDigest: string;
}>;
export type SourceVocabularyBindings = Readonly<{
  /** The immutable definition descriptor that admitted the statements and targets. */
  releaseDigest: string;
  schemes: readonly ResolvedScheme[];
  concepts: readonly ResolvedConcept[];
}>;

export type SourceRowOrigin = Readonly<{
  externalId?: string;
  revision?: string | null;
  digest?: string;
  url?: string;
}>;
type RowBase = Readonly<{ path: string; origin?: SourceRowOrigin }>;
export type BangumiVocabularyRow =
  | (RowBase & { kind: 'episode-sort'; episode: NativeIdentity; sort: string | number })
  | (RowBase & { kind: 'episode-kind'; episode: NativeIdentity; code: string | number })
  | (RowBase & { kind: 'character-kind'; character: NativeIdentity; code: string | number })
  | (RowBase & {
      kind: 'staff'; subject: NativeIdentity; holder?: NativeIdentity; holderCode: string; subjectType: 1 | 2 | 4;
      roleCode: number; creditedAs?: string; order?: number;
    })
  | (RowBase & {
      kind: 'character-appearance'; subject: NativeIdentity; character?: NativeIdentity; characterCode: string; roleCode: number;
    })
  | (RowBase & {
      kind: 'voice-credit'; subject: NativeIdentity; performer?: NativeIdentity; performerCode: string;
      character?: NativeIdentity; characterCode: string; creditedAs?: string;
    })
  | (RowBase & {
      kind: 'relation'; subject: NativeIdentity; endpoint?: NativeIdentity; endpointCode: string; family: 1 | 2 | 4;
      code: number; reciprocalCode?: number | null;
    });

export type VndbVocabularyRow =
  | (RowBase & { kind: 'release-date'; release: NativeIdentity; value: string | null })
  | (RowBase & { kind: 'development-status'; subject: NativeIdentity; code: number })
  | (RowBase & { kind: 'release-supersedes'; release: NativeIdentity; endpoint?: NativeIdentity; endpointCode: string })
  | (RowBase & { kind: 'release-work'; release: NativeIdentity; work?: NativeIdentity; workCode: string; completenessCode: string })
  | (RowBase & { kind: 'staff'; subject: NativeIdentity; holder?: NativeIdentity; holderCode: string; roleCode: string; creditedAs?: string })
  | (RowBase & { kind: 'tag'; subject: NativeIdentity; category: 'cont' | 'ero' | 'tech'; code: string; spoiler: number })
  | (RowBase & { kind: 'character-trait'; character: NativeIdentity; code: string; spoiler: number });

export type SourceVocabularyRow = BangumiVocabularyRow | VndbVocabularyRow;
export type SourceVocabularyRequest = Readonly<{
  bindings: SourceVocabularyBindings;
  rows: readonly SourceVocabularyRow[];
}>;
export type SourceVocabularyMetadata = Readonly<{
  provider: SourceVocabularyProvider;
  sourceAlias: string;
  externalId: string;
  recordRevision: string | null;
  digest: string;
  converterRevision: string;
  recordUrl: string;
  license: string;
  attribution: string;
}>;
export type SourceVocabularyInput = Readonly<{
  metadata: SourceVocabularyMetadata;
  bindings: SourceVocabularyBindings;
  rows: readonly SourceVocabularyRow[];
  /** Available slots after any ordinary proposals from the registered source converter. */
  commandLimit?: number;
}>;
export type SourceVocabularyGap = Readonly<{
  provider: SourceVocabularyProvider;
  path: string;
  code?: string;
  endpoint?: string;
  reason:
    | 'unknown_code'
    | 'missing_concept'
    | 'missing_scheme'
    | 'missing_release'
    | 'missing_identity'
    | 'incompatible_identity'
    | 'property_not_admitted'
    | 'qualifier_not_admitted'
    | 'invalid_source_value'
    | 'unsupported_source_case'
    | 'command_limit'
    | 'invalid_row';
  requiredProfile?: string;
  property?: string;
}>;
export type SourceVocabularyResult = Readonly<{
  proposals: readonly BatchCommand[];
  gaps: readonly SourceVocabularyGap[];
}>;
type SourceVocabularyGapInput = Omit<SourceVocabularyGap, 'provider' | 'code' | 'endpoint' | 'requiredProfile' | 'property'> & {
  provider?: SourceVocabularyProvider;
  code?: string | undefined;
  endpoint?: string | undefined;
  requiredProfile?: string | undefined;
  property?: string | undefined;
};

export type MappingEnvironment = Readonly<{
  input: SourceVocabularyInput;
  rows: readonly unknown[];
  commandLimit: number;
  release: Release;
  proposals: BatchCommand[];
  gaps: SourceVocabularyGap[];
  admit(subject: NativeIdentity, property: string, path: string, code?: string, endpoint?: string): boolean;
  pushGap(gap: SourceVocabularyGapInput): void;
  propose(args: {
    row: SourceVocabularyRow;
    subject: NativeIdentity;
    property: string;
    content: unknown;
    qualifiers?: readonly { property: string; content: unknown; identity?: NativeIdentity }[];
    target?: NativeIdentity;
    sourceEndpoint?: string;
    mappingRevision: string;
  }): void;
  concept(taxonomy: string, code: string, path: string, endpoint?: string): ResolvedConcept | null;
  sourcePath(value: unknown): string | null;
  sourceCode(value: unknown): string | null;
  isRow(value: unknown, kinds: readonly string[]): boolean;
  identityId(value: unknown): string | null;
}>;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor?.enumerable && 'value' in descriptor;
    });
  } catch {
    return false;
  }
}
function sourceText(value: unknown, maximum = 500): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.isWellFormed() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function profileBases(release: Release, type: string): Set<string> {
  const found = new Set<string>();
  const pending = [type];
  while (pending.length) {
    const next = pending.pop()!;
    if (found.has(next)) continue;
    found.add(next);
    for (const base of release.types[next]?.bases ?? []) pending.push(base);
  }
  return found;
}
function identityCompatible(identity: NativeIdentity, release: Release, digest: string): boolean {
  return record(identity) && typeof identity.id === 'string' && uuidPattern.test(identity.id) && identity.releaseDigest === digest &&
    typeof identity.type === 'string' && Object.hasOwn(release.types, identity.type);
}
function propertyDefinition(release: Release, id: string): PropertyDefinition | undefined {
  return release.properties[id];
}
function valueTargetAllowed(definition: PropertyDefinition, target: NativeIdentity, release: Release): boolean {
  if (!definition.targets?.length) return true;
  const targets = new Set(definition.targets);
  for (const base of profileBases(release, target.type)) if (targets.has(base)) return true;
  return false;
}
function propertyAllowed(subject: NativeIdentity, property: string, release: Release): PropertyDefinition | null {
  const type = release.types[subject.type];
  const definition = propertyDefinition(release, property);
  return type && definition && type.properties.includes(property) ? definition : null;
}
function textQualifier(property: string, content: unknown) {
  return { property: { id: property }, value: { type: 'value' as const, content } };
}

function readArray(value: unknown, limit: number): { values: unknown[]; valid: boolean; overflow: boolean } {
  if (value === undefined) return { values: [], valid: true, overflow: false };
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return { values: [], valid: false, overflow: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = descriptor && 'value' in descriptor ? descriptor.value : -1;
  if (!Number.isSafeInteger(length) || length < 0) return { values: [], valid: false, overflow: false };
  const values: unknown[] = [];
  let valid = true;
  for (let index = 0; index < Math.min(length, limit); index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !entry.enumerable || !('value' in entry)) {
      values.push(null);
      valid = false;
    } else values.push(entry.value);
  }
  return { values, valid, overflow: length > limit };
}

/**
 * Build a bounded conversion environment over the exact published immutable release. The caller
 * supplies native identities; this module checks each identity, profile, target and qualifier.
 */
export function createMappingEnvironment(input: SourceVocabularyInput): MappingEnvironment {
  const rawInput = record(input) ? input : null;
  const rawMetadata = rawInput && record(rawInput.metadata) ? rawInput.metadata : null;
  const rawBindings = rawInput && record(rawInput.bindings) ? rawInput.bindings : null;
  const provider: SourceVocabularyProvider = rawMetadata?.provider === 'vndb' ? 'vndb' : 'bangumi';
  const rawRevision = rawMetadata?.recordRevision;
  const recordRevision = rawRevision === null ? null : sourceText(rawRevision, 64) ? rawRevision : null;
  const metadata: SourceVocabularyMetadata = {
    provider,
    sourceAlias: sourceText(rawMetadata?.sourceAlias, 32) ? rawMetadata.sourceAlias : '',
    externalId: sourceText(rawMetadata?.externalId, 255) ? rawMetadata.externalId : '',
    recordRevision,
    digest: typeof rawMetadata?.digest === 'string' ? rawMetadata.digest : '',
    converterRevision: sourceText(rawMetadata?.converterRevision, 64) ? rawMetadata.converterRevision : '',
    recordUrl: sourceText(rawMetadata?.recordUrl, 2048) ? rawMetadata.recordUrl : '',
    license: sourceText(rawMetadata?.license, 128) ? rawMetadata.license : '',
    attribution: sourceText(rawMetadata?.attribution, 500) ? rawMetadata.attribution : '',
  };
  const proposals: BatchCommand[] = [];
  const gaps: SourceVocabularyGap[] = [];
  const sourceDigestValid = digestPattern.test(metadata.digest);
  const revisionValid = rawRevision === null || sourceText(rawRevision, 64);
  const sourceMetadataValid = !!rawInput && !!rawMetadata && !!rawBindings &&
    (rawMetadata.provider === 'bangumi' || rawMetadata.provider === 'vndb') &&
    /^[a-z][a-z0-9_-]{0,31}$/u.test(metadata.sourceAlias) && sourceText(metadata.externalId, 255) && revisionValid &&
    sourceDigestValid && sourceText(metadata.converterRevision, 64) && sourceText(metadata.recordUrl, 2048) &&
    sourceText(metadata.license, 128) && sourceText(metadata.attribution, 500);
  const releaseDigest = rawBindings?.releaseDigest;
  const releaseMatches = typeof releaseDigest === 'string' && releaseDigest === bundledDigest;
  const release = bundledRelease;
  const rawSchemes = readArray(rawBindings?.schemes, sourceVocabularyLimits.schemes);
  const rawConcepts = readArray(rawBindings?.concepts, sourceVocabularyLimits.concepts);
  const rawRows = readArray(rawInput?.rows, sourceVocabularyLimits.rows);
  const rowsPresent = !!rawInput && Object.hasOwn(rawInput, 'rows');
  const requestedCommandLimit = rawInput?.commandLimit;
  const commandLimitValid = requestedCommandLimit === undefined ||
    Number.isSafeInteger(requestedCommandLimit) && requestedCommandLimit >= 0 && requestedCommandLimit <= BATCH_LIMIT;
  const commandLimit = commandLimitValid
    ? typeof requestedCommandLimit === 'number' ? requestedCommandLimit : BATCH_LIMIT
    : 0;
  const schemes = rawSchemes.values.filter((entry): entry is ResolvedScheme => record(entry));
  const concepts = rawConcepts.values.filter((entry): entry is ResolvedConcept => record(entry));
  const rows = rawRows.values;
  const safeInput: SourceVocabularyInput = {
    metadata,
    bindings: { releaseDigest: typeof releaseDigest === 'string' ? releaseDigest : '', schemes, concepts },
    rows: rows as SourceVocabularyRow[],
    commandLimit,
  };

  const pushGap = (gap: SourceVocabularyGapInput) => {
    if (gaps.length >= sourceVocabularyLimits.gaps) return;
    const path = typeof gap.path === 'string' && /^\/[A-Za-z0-9_./~\-]{1,180}$/u.test(gap.path) ? gap.path : '/sourceVocabulary';
    const code = sourceText(gap.code, 64) ? gap.code : undefined;
    const endpoint = sourceText(gap.endpoint, 128) ? gap.endpoint : undefined;
    const requiredProfile = sourceText(gap.requiredProfile, 64) ? gap.requiredProfile : undefined;
    const property = sourceText(gap.property, 64) ? gap.property : undefined;
    gaps.push({
      provider: gap.provider ?? provider,
      path,
      ...(code === undefined ? {} : { code }),
      ...(endpoint === undefined ? {} : { endpoint }),
      reason: gap.reason,
      ...(requiredProfile === undefined ? {} : { requiredProfile }),
      ...(property === undefined ? {} : { property }),
    });
  };
  const sourcePath = (value: unknown): string | null =>
    typeof value === 'string' && value.length <= 180 && /^\/[A-Za-z0-9_./~\-]+$/u.test(value) ? value : null;
  const sourceCode = (value: unknown): string | null => {
    if (sourceText(value, 64)) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    return null;
  };
  const isRow = (value: unknown, kinds: readonly string[]): boolean =>
    record(value) && typeof value.kind === 'string' && kinds.includes(value.kind);
  const identityId = (value: unknown): string | null => {
    if (!record(value) || !identityCompatible(value as NativeIdentity, release, bundledDigest)) return null;
    return typeof value.id === 'string' ? value.id : null;
  };
  const concept = (taxonomy: string, code: string, path: string, endpoint?: string): ResolvedConcept | null => {
    if (!releaseMatches) {
      pushGap({ path, code, endpoint, reason: 'missing_release', requiredProfile: bundledDigest });
      return null;
    }
    const scheme = schemes.find((entry) => record(entry) && entry.taxonomy === taxonomy);
    if (!scheme || typeof scheme.id !== 'string' || !uuidPattern.test(scheme.id) || scheme.type !== 'skos:ConceptScheme' ||
      scheme.releaseDigest !== bundledDigest || !sourceText(scheme.uri, 512) || !release.types[scheme.type]) {
      pushGap({ path, code, endpoint, reason: 'missing_scheme', property: 'skos:ConceptScheme', requiredProfile: 'skos:ConceptScheme' });
      return null;
    }
    const binding = concepts.find((entry) => record(entry) && entry.taxonomy === taxonomy && entry.code === code);
    if (!binding || typeof binding.id !== 'string' || !uuidPattern.test(binding.id) || binding.type !== 'skos:Concept' ||
      binding.schemeId !== scheme.id || binding.releaseDigest !== bundledDigest || !release.types[binding.type]) {
      pushGap({ path, code, endpoint, reason: 'missing_concept', property: 'skos:Concept', requiredProfile: 'skos:Concept' });
      return null;
    }
    return binding;
  };
  const admit = (subject: NativeIdentity, property: string, path: string, code?: string, endpoint?: string): boolean => {
    if (!releaseMatches || !identityCompatible(subject, release, bundledDigest)) {
      const requiredProfile = identityId(subject) ? subject.type : undefined;
      pushGap({ path, ...(code ? { code } : {}), ...(endpoint ? { endpoint } : {}), reason: 'incompatible_identity', property, requiredProfile });
      return false;
    }
    if (!propertyAllowed(subject, property, release)) {
      pushGap({ path, ...(code ? { code } : {}), ...(endpoint ? { endpoint } : {}), reason: 'property_not_admitted', property, requiredProfile: subject.type });
      return false;
    }
    return true;
  };
  const propose: MappingEnvironment['propose'] = ({ row, subject, property, content, qualifiers, target, sourceEndpoint, mappingRevision }) => {
    const path = sourcePath(row.path) ?? '/sourceVocabulary';
    const rowCode = 'code' in row ? sourceCode(row.code) : 'roleCode' in row ? sourceCode(row.roleCode) : null;
    if (!sourceMetadataValid || !sourceDigestValid) {
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'invalid_row' });
      return;
    }
    if (!admit(subject, property, path, rowCode ?? undefined, sourceEndpoint)) {
      return;
    }
    const definition = propertyAllowed(subject, property, release)!;
    if (target && (!identityCompatible(target, release, bundledDigest) || !valueTargetAllowed(definition, target, release))) {
      const targetValid = identityCompatible(target, release, bundledDigest);
      const endpoint = sourceCode(sourceEndpoint) ?? (targetValid ? target.id : undefined);
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), ...(endpoint ? { endpoint } : {}), reason: 'incompatible_identity', property,
        ...(targetValid ? { requiredProfile: target.type } : {}) });
      return;
    }
    const terms = qualifiers ?? [];
    for (const term of terms) {
      const qualifier = propertyDefinition(release, term.property);
      if (!definition.qualifiers.includes(term.property) || !qualifier ||
        (qualifier.datatype === 'wikibase-item' &&
          (!term.identity || !identityCompatible(term.identity, release, bundledDigest) ||
            !valueTargetAllowed(qualifier, term.identity, release) || term.identity.id !== term.content))) {
        const requiredProfile = term.identity && identityId(term.identity) ? term.identity.type : undefined;
        pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'qualifier_not_admitted', property: term.property, requiredProfile });
        return;
      }
    }
    const origin = row.origin;
    if (origin !== undefined && !record(origin)) {
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'invalid_row' });
      return;
    }
    if (origin && ((origin.externalId !== undefined && !sourceText(origin.externalId, 255)) ||
      (origin.revision !== undefined && origin.revision !== null && !sourceText(origin.revision, 64)) ||
      (origin.digest !== undefined && (typeof origin.digest !== 'string' || !digestPattern.test(origin.digest))) ||
      (origin.url !== undefined && !sourceText(origin.url, 2048)))) {
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'invalid_row' });
      return;
    }
    const externalId = origin && sourceText(origin.externalId, 255) ? origin.externalId : metadata.externalId;
    const revision = origin && origin.revision !== undefined ? origin.revision : metadata.recordRevision;
    const digest = origin && typeof origin.digest === 'string' && digestPattern.test(origin.digest) ? origin.digest : metadata.digest;
    const sourceUrl = origin && sourceText(origin.url, 2048) ? origin.url : metadata.recordUrl;
    let url: string;
    try {
      const parsed = new URL(safeSourceUrl(sourceUrl, metadata.provider === 'bangumi'
        ? ['bgm.tv', 'bangumi.tv', 'chii.in']
        : ['vndb.org']));
      parsed.hash = path;
      url = parsed.href;
    } catch {
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'invalid_row' });
      return;
    }
    if (!sourceText(externalId, 255) || (revision !== null && !sourceText(revision, 64)) || !digestPattern.test(digest)) {
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'invalid_row' });
      return;
    }
    const rowSource = sourceEnvelope({
      source: metadata.sourceAlias,
      external_id: externalId,
      record_revision: revision,
      converter_revision: metadata.converterRevision,
      digest,
    }, 'facts');
    const reference: BatchReference = {
      parts: [
        textQualifier('schema:url', url),
        textQualifier('schema:version', revision ?? 'unversioned'),
      ],
    };
    const statement: BatchStatement = {
      property: { id: property },
      value: { type: 'value', content: target?.id ?? content },
      ...(terms.length ? { qualifiers: terms.map((term) => textQualifier(term.property, term.content)) } : {}),
      references: [reference],
    };
    const rights = {
      license: metadata.license,
      obligations: ['cc:Attribution', 'cc:ShareAlike'] as const,
      attribution: metadata.attribution,
    };
    const proposalDigest = JSON.stringify([rowSource, statement, rights]);
    const key = commandKey([
      metadata.provider,
      metadata.sourceAlias,
      externalId,
      revision ?? 'unversioned',
      digest,
      metadata.converterRevision,
      sourceVocabularyRevision,
      mappingRevision,
      path,
      subject.id,
      proposalDigest,
    ]);
    const command: BatchCommand = {
      op: 'propose', source: rowSource, key, subject: subject.id, statement,
      rights: { ...rights, obligations: [...rights.obligations] },
    };
    if (proposals.length >= commandLimit) {
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'command_limit' });
      return;
    }
    if (checkBatchWrite({ commands: [command] }, release).length) {
      pushGap({ path, ...(rowCode ? { code: rowCode } : {}), reason: 'property_not_admitted', property, requiredProfile: subject.type });
      return;
    }
    proposals.push(command);
  };
  if (!sourceMetadataValid) {
    pushGap({ path: '/sourceVocabulary/metadata', reason: 'invalid_row' });
  }
  if (!rowsPresent || !rawRows.valid) pushGap({ path: '/sourceVocabulary/rows', reason: 'invalid_row' });
  if (!commandLimitValid) pushGap({ path: '/sourceVocabulary/commandLimit', reason: 'command_limit' });
  if (rawRows.overflow) pushGap({ path: '/sourceVocabulary/rows', reason: 'command_limit' });
  if (rawSchemes.overflow) pushGap({ path: '/sourceVocabulary/bindings/schemes', reason: 'command_limit' });
  if (rawConcepts.overflow) pushGap({ path: '/sourceVocabulary/bindings/concepts', reason: 'command_limit' });
  if (!rawSchemes.valid || !rawConcepts.valid) {
    pushGap({ path: '/sourceVocabulary/bindings', reason: 'invalid_row' });
  }
  if (!releaseMatches) pushGap({ path: '/sourceVocabulary/bindings/releaseDigest', reason: 'missing_release', requiredProfile: bundledDigest });
  return { input: safeInput, rows, commandLimit, release, proposals, gaps, admit, pushGap, propose, concept, sourcePath, sourceCode, isRow, identityId };
}

export function finishMapping(environment: MappingEnvironment): SourceVocabularyResult {
  return { proposals: environment.proposals, gaps: environment.gaps };
}
