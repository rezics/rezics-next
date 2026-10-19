import { t } from 'elysia';
import { associationValue } from '../query/association-contract.ts';
import { statementCoverageSchema, statementQualificationSchema } from '../statement/contract.ts';
import { SYNOPSIS_TEXT_LIMIT } from './field-control-language.ts';
import type { RetainedSupportRequest } from './field-support-contract.ts';
import { EXPORT_BASIS_KINDS, EXPORT_OBLIGATIONS, EXPORT_USE_SCOPES } from '../export/schema.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const receipt = t.String({ pattern: '^urn:rezics:receipt:[0-9a-f]{64}$' });
const term = t.String({ minLength: 1, maxLength: 2048, pattern: '^https?://[^\\s<>"{}|\\\\^`]+$' });
export const suppliedLanguageSchema = t.Union([
  t.Object({ state: t.Literal('omitted') },closed), t.Object({ state: t.Literal('null') },closed),
  t.Object({ state: t.Literal('value'), value: t.String({ maxLength: 255 }) },closed),
]);
const field = t.Object({ pointer: t.String({ minLength: 1, maxLength: 4096 }),
  presence: t.Union((['value','omitted','null','empty-string','empty-array','empty-object'] as const).map(v => t.Literal(v))),
  valueDigest: t.Optional(digest), ordinal: t.Optional(t.Integer({ minimum: 0 })),
  language: t.Optional(t.Nullable(t.String({ maxLength: 255 }))) },closed);
const evidence = t.Object({ binding: id, recordDigest: digest,
  mappingRevision: t.String({ minLength: 1, maxLength: 100 }), field },closed);
const editorialValue = t.Union([
  t.Object({ kind: t.Literal('string'), lexical: t.String({ minLength: 1, maxLength: SYNOPSIS_TEXT_LIMIT }) },closed),
  t.Object({ kind: t.Literal('language-string'), lexical: t.String({ minLength: 1, maxLength: SYNOPSIS_TEXT_LIMIT }),
    language: t.String({ minLength: 1, maxLength: 255 }) },closed),
]);
const command = { component: id, revision: id, receipt, expectedHead: id };
const completeness = t.Union((['complete','partial','trial','unknown'] as const).map(value => t.Literal(value)));
const releaseBasis = t.Object(command,closed);
const statementBasis = { kind: t.Literal('statement'), owner: t.Literal('statement'), target: id, revision: id, receipt,
  statement: id, relationDefinition: term, predicate: term, context: t.String({ minLength: 1, maxLength: 2048 }),
  acceptance: t.Nullable(t.Object({ context: t.String(), decision: id, source: t.String() },closed)) };
const native = t.Union([
  t.Object({ kind: t.Literal('component-property'), owner: t.Literal('semantic'), target: id,
    component: id, revision: id, receipt, property: t.Object({ predicate: term, value: associationValue },closed) },closed),
  t.Object({ kind: t.Literal('component-property'), owner: t.Literal('work-editorial'), target: id,
    component: t.String({ pattern: '^urn:rezics:editorial-field:[0-9a-f]{64}$' }),
    revision: id, receipt, field: t.Literal('synopsis'), language: suppliedLanguageSchema,
    property: t.Object({ predicate: t.Literal('https://schema.org/description'), value: editorialValue },closed) },closed),
  t.Object({ kind: t.Literal('component-property'), owner: t.Literal('release'), target: id, ...command,
    property: t.Object({ predicate: term, value: associationValue },closed),
    coverage: t.Object({ realization: releaseBasis, completeness },closed) },closed),
  t.Object({ kind: t.Literal('component-property'), owner: t.Literal('realization'), target: id, ...command,
    property: t.Object({ predicate: term, value: associationValue },closed),
    release: releaseBasis, completeness },closed),
  t.Object({ ...statementBasis,
    value: t.Union([
      t.Object({ kind: t.Literal('resource'), iri: term },closed),
      t.Object({ kind: t.Literal('literal'), lexical: t.String({ maxLength: 8000 }), datatype: term,
        language: t.Nullable(t.String({ maxLength: 255 })) },closed),
      t.Object({ kind: t.Literal('some-value') },closed), t.Object({ kind: t.Literal('no-value') },closed),
    ]), qualifiers: t.Object({ applicability: t.Array(term,{ maxItems: 64 }),
      interpretationDefinitions: t.Array(term,{ maxItems: 64 }),
      qualification: t.Optional(t.Record(t.String(),t.Unknown())) },closed),
  },closed),
  t.Object({ ...statementBasis, value: associationValue, coverage: statementCoverageSchema,
    qualifiers: t.Object({ applicability: t.Array(term,{ maxItems: 64 }),
      interpretationDefinitions: t.Array(term,{ maxItems: 64 }),
      qualification: t.Optional(statementQualificationSchema) },closed) },closed),
]);
export const retainedSupportRequest = t.Unsafe<RetainedSupportRequest>(t.Object({
  profile: t.Literal('source-field-support-attachment-v2'), target: id,
  slot: t.String({ minLength: 1, maxLength: 512 }), occurrence: t.Nullable(id),
  context: t.String({ minLength: 1, maxLength: 2048 }), sourceRecord: id, conversion: id,
  grain: t.String({ minLength: 1, maxLength: 64 }), sourceField: t.String({ minLength: 1, maxLength: 200 }),
  sourceOccurrence: t.Nullable(t.String({ maxLength: 100 })), expectedHead: id, actingSubject: id,
  evidence, native },closed));
export const retainedSupportAdmission = t.Object({ profile: t.Literal('source-field-support-admission-v1'),
  sourceRecord: id, conversion: id, evidence, native,
  correspondence: t.Object({ normalizationRevision: t.String(), rule: t.String(),
    payloadPointers: t.Array(t.String()), selectedValueDigest: digest },closed),
  headGuarantee: t.Literal('verified-before-commit') },closed);
export const fieldAttachmentCertificate = t.Object({ profile: t.Literal('source-field-attachment-certificate-v1'),
  receipt, requestDigest: digest, nativeReceipt: receipt },closed);
export const retainedPublicEvidence = t.Object({ id, sourceWork: t.Null(), representationSha256: digest,
  locator: t.Object({ pointer: t.String() },closed), rightsBasis: t.Object({
    basisKind: t.Union(EXPORT_BASIS_KINDS.map(value => t.Literal(value))),
    basisRef: t.Nullable(t.String()),licenseExpression: t.Nullable(t.String()),notice: t.Nullable(t.String()),
    obligations: t.Array(t.Union(EXPORT_OBLIGATIONS.map(value => t.Literal(value)))),
    useScope: t.Union(EXPORT_USE_SCOPES.map(value => t.Literal(value))),
    result: t.Union((['supported','conditional','undetermined','prohibited'] as const).map(value => t.Literal(value))),
    memberOrdinals: t.Array(t.Integer({ minimum: 1 })),
  },closed), quote: t.Nullable(t.String()),quoteWithheld: t.Boolean(),
  attribution: t.Object({ sourceName: t.String(), sourceUrl: t.Nullable(t.String()), licence: t.Nullable(t.String()) },closed),
  language: suppliedLanguageSchema },closed);
