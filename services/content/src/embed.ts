/** Exact Content revision references carried by a text draft. */
export const CONTENT_EMBED_LIMITS = { direct: 16, closure: 64, depth: 8,
  bytes: 4_194_304 } as const;
const revisionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ContentEmbedInvalid extends Error {}

export function directContentEmbeds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CONTENT_EMBED_LIMITS.direct
    || value.some(item => typeof item !== 'string' || !revisionId.test(item))
    || new Set(value).size !== value.length) {
    throw new ContentEmbedInvalid('exact Content embed set is invalid or exceeds its bound');
  }
  return value as string[];
}
