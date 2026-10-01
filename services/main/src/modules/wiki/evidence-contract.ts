import { t } from 'elysia';

export const wikiClaimEvidence = t.Object(
  {
    id: t.String(),
    sourceWork: t.String(),
    representationSha256: t.String(),
    locator: t.Unknown(),
    quote: t.Nullable(t.String()),
    quoteWithheld: t.Boolean(),
    method: t.Unknown(),
    modality: t.String(),
    submitter: t.String(),
    rightsBasis: t.String(),
  },
  { additionalProperties: false },
);
