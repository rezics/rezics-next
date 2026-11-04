export type ResultFreshness = { state: 'current' | 'catching-up' | 'unavailable' };

/** as_of is legacy native context, never a complete indexed-through watermark. */
export function resultFreshness(value: unknown, asOf: unknown): ResultFreshness {
  if (
    typeof asOf !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(asOf) ||
    !Number.isFinite(Date.parse(asOf)) ||
    new Date(asOf).toISOString().slice(0, 19) !== asOf.slice(0, 19)
  )
    return { state: 'unavailable' };
  if (!value || typeof value !== 'object' || !('state' in value) || Object.keys(value).length !== 1)
    return { state: 'unavailable' };
  return { state: value.state === 'current' || value.state === 'catching-up' ? value.state : 'unavailable' };
}
