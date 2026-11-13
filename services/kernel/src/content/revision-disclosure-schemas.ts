import { t } from 'elysia';
import { HostedChapterTargetSchema, HostedIdSchema } from './hosted-chapters-schemas.ts';

const closed = { additionalProperties: false } as const;

/** Exact selected opening. The path Post UUID must equal `target.postId`. */
export const RevisionDisclosureTargetSchema = HostedChapterTargetSchema;

/** Intended Book catalogue Post. Catalogue ownership never admits the source command. */
export const RevisionDisclosureCatalogueIdSchema = HostedIdSchema;

/**
 * Issue names the intended Book and the exact private opening. Membership, draft
 * bytes and privileged access controls are not request fields.
 */
export const RevisionDisclosureIssueSchema = t.Object(
  {
    catalogueId: RevisionDisclosureCatalogueIdSchema,
    target: RevisionDisclosureTargetSchema,
  },
  closed,
);

/**
 * Revoke names the issued grant and repeats the exact source tuple and Book.
 * The route binds those fields to the stored grant; membership is not a field.
 */
export const RevisionDisclosureRevokeSchema = t.Object(
  {
    disclosureId: HostedIdSchema,
    catalogueId: RevisionDisclosureCatalogueIdSchema,
    target: RevisionDisclosureTargetSchema,
  },
  closed,
);

/** Original command receipt. Initiator secrets, source bytes and grants stay out. */
export const RevisionDisclosureReceiptSchema = t.Object(
  {
    disclosureId: HostedIdSchema,
    state: t.Union([t.Literal('issued'), t.Literal('revoked')]),
    catalogueId: RevisionDisclosureCatalogueIdSchema,
    reused: t.Boolean(),
    durableInitiator: t.Optional(t.String({ pattern: '^[0-9a-f]{64}$' })),
  },
  closed,
);
