import { t } from 'elysia';
import type { Static } from 'typebox';

const url = t.String({ pattern: '^https://[^\\s]{1,500}$', maxLength: 512 });
const term = t.String({ minLength: 1, maxLength: 80 });
const workId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const image = t.Object({ url, width: t.Integer({ minimum: 1, maximum: 8192 }),
  height: t.Integer({ minimum: 1, maximum: 8192 }), source: url }, { additionalProperties: false });
const release = t.Object({ platform: term, architecture: t.Nullable(term), version: t.Nullable(term),
  changes: t.Nullable(t.String({ maxLength: 1000 })), destination: url, source: url,
  observedAt: t.String({ format: 'date-time' }) }, { additionalProperties: false });
const alternative = t.Object({ work: workId, reason: t.String({ minLength: 1, maxLength: 240 }),
  attributedTo: workId }, { additionalProperties: false });

/** A null version or architecture means REZICS has no tracked assertion for it.
 * `destination` is a project handoff, never a REZICS installation action. */
export const softwareFacts = t.Object({ profile: t.Literal('software-facts-v1'),
  pitch: t.String({ minLength: 1, maxLength: 500 }), project: url, source: url,
  maintainer: term, license: t.Nullable(term), observedAt: t.String({ format: 'date-time' }),
  screenshots: t.Array(image, { maxItems: 6 }),
  releases: t.Array(release, { maxItems: 8 }),
  alternatives: t.Array(alternative, { maxItems: 8 }),
}, { additionalProperties: false });

export type SoftwareFacts = Static<typeof softwareFacts>;
export const SOFTWARE_FACTS_COST = { workRows: 1, releaseItems: 8,
  alternativeItems: 8, screenshotItems: 6, graphQueries: 2 } as const;
