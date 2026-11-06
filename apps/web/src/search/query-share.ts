import * as v from 'valibot';
export const queryShareSchema = v.object({
  viewer: v.optional(v.picklist(['anonymous', 'signed-in']), 'anonymous'),
  action: v.picklist(['allowed', 'disabled', 'unavailable']),
  reason: v.picklist(['ready', 'private_context', 'unsupported', 'oversized', 'unavailable']),
  document: v.nullable(
    v.object({
      text: v.pipe(v.string(), v.maxLength(512)),
      filter: v.nullable(v.string()),
      languages: v.pipe(v.array(v.pipe(v.string(), v.maxLength(35))), v.maxLength(8)),
      sort: v.nullable(v.string()),
      textField: v.optional(v.literal('credited_creator')),
      creditQualifiers: v.optional(
        v.pipe(
          v.array(
            v.object({
              property: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
              value: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
            }),
          ),
          v.maxLength(4),
        ),
      ),
      spoilerThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2))),
    }),
  ),
  parameters: v.nullable(v.pipe(v.string(), v.maxLength(8192))),
  selections: v.pipe(
    v.array(
      v.object({
        value: v.pipe(v.string(), v.maxLength(256)),
        language: v.pipe(v.string(), v.maxLength(35)),
      }),
    ),
    v.maxLength(128),
  ),
});
export type QueryShare = v.InferOutput<typeof queryShareSchema>;
export const shareUnavailable = (): QueryShare => ({
  viewer: 'anonymous',
  action: 'unavailable',
  reason: 'unavailable',
  document: null,
  parameters: null,
  selections: [],
});
export function parseQueryShare(value: unknown): QueryShare {
  const parsed = v.safeParse(queryShareSchema, value);
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.output)).length > 65536)
    return shareUnavailable();
  return parsed.output;
}
export function queryShareUrl(origin: string, locale: string, share: QueryShare): string | null {
  if (share.action !== 'allowed' || share.parameters === null || !share.document) return null;
  const path = share.document.textField === 'credited_creator' ? 'search/characters' : 'search';
  const url = new URL(`/${encodeURIComponent(locale)}/${path}?${share.parameters}`, origin);
  return url.origin === new URL(origin).origin && new TextEncoder().encode(url.href).length <= 8192 ? url.href : null;
}
