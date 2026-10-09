/** Sorted-key JSON for digests and stored records.
 * An object entry whose value is `undefined` is omitted, which is the byte
 * form already stored for dataset records. Every other value, including an
 * `undefined` array element, goes through `JSON.stringify` (an undefined
 * element contributes no token, so the comma remains). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
