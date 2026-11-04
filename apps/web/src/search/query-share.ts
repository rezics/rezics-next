import * as v from 'valibot';
export const queryShareSchema = v.object({
  action: v.picklist(['allowed', 'disabled', 'unavailable']),
  reason: v.picklist(['ready', 'private_context', 'unsupported', 'oversized', 'unavailable']),
  document: v.nullable(
    v.object({
      text: v.string(),
      filter: v.nullable(v.string()),
      languages: v.array(v.string()),
      sort: v.nullable(v.string()),
    }),
  ),
  parameters: v.nullable(v.string()),
  selections: v.array(v.object({ value: v.string(), language: v.string() })),
});
export type QueryShare = v.InferOutput<typeof queryShareSchema>;
export const shareUnavailable = (): QueryShare => ({
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
  const url = new URL(`/${encodeURIComponent(locale)}/search?${share.parameters}`, origin);
  return url.origin === new URL(origin).origin && new TextEncoder().encode(url.href).length <= 8192 ? url.href : null;
}
