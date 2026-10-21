import { t } from 'elysia';
import type { Static } from 'typebox';
import { EXPORT_BASIS_KINDS, EXPORT_OBLIGATIONS, EXPORT_USE_SCOPES } from '../export/schema.ts';
import type { PublicRetainedFieldEvidence } from '../source/retained-evidence.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const digest = t.String({ pattern: '^[a-f0-9]{64}$' });

/** Existing manually submitted Wiki evidence keeps its transport meaning. */
export interface ManualAssociationCitation {
  id: string;
  sourceWork: string;
  representationSha256: string;
  locator: unknown;
  quote: string | null;
  quoteWithheld: boolean;
  method: unknown;
  modality: string;
  submitter: string;
  rightsBasis: string;
}
export const manualAssociationCitation = t.Unsafe<ManualAssociationCitation>(t.Object({ id, sourceWork: id,
  representationSha256: digest, locator: t.Unknown(),
  quote: t.Nullable(t.String()), quoteWithheld: t.Boolean(), method: t.Unknown(),
  modality: t.String(), submitter: id, rightsBasis: t.String() }, closed));

const rightsBasis = t.Object({ basisKind: t.Enum(EXPORT_BASIS_KINDS),
  basisRef: t.Nullable(t.String()), licenseExpression: t.Nullable(t.String()), notice: t.Nullable(t.String()),
  obligations: t.Array(t.Enum(EXPORT_OBLIGATIONS)),
  useScope: t.Enum(EXPORT_USE_SCOPES),
  result: t.Enum(['supported', 'conditional', 'undetermined', 'prohibited']),
  memberOrdinals: t.Array(t.Integer({ minimum: 0 })),
}, closed);
const suppliedLanguage = t.Union([
  t.Object({ state: t.Literal('omitted') }, closed), t.Object({ state: t.Literal('null') }, closed),
  t.Object({ state: t.Literal('value'), value: t.String({ maxLength: 255, pattern: '^[^\u0000-\u001f\u007f]*$' }) }, closed),
]);

/** A retained record has no Source Work, method or submitting Wiki user.
 * Independent supports of the same record remain independent citations. */
export interface RetainedSourceFieldCitation extends PublicRetainedFieldEvidence {
  kind: 'retained-source-field';
  supportIdentity: string;
  record: string;
}
export const retainedSourceFieldCitation = t.Unsafe<RetainedSourceFieldCitation>(t.Object({ kind: t.Literal('retained-source-field'),
  id, supportIdentity: id, record: id, sourceWork: t.Null(), representationSha256: digest,
  locator: t.Object({ pointer: t.String({ minLength: 1, maxLength: 2048, pattern: '^/' }) }, closed),
  attribution: t.Object({ sourceName: t.String(), sourceUrl: t.Nullable(t.String()), licence: t.Nullable(t.String()) }, closed),
  rightsBasis, quote: t.Nullable(t.String()), quoteWithheld: t.Boolean(), language: suppliedLanguage,
}, closed));
export const associationEvidenceCitation = t.Union([manualAssociationCitation, retainedSourceFieldCitation]);
export type AssociationEvidenceCitation = Static<typeof associationEvidenceCitation>;
