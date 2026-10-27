export type Exposure = { kind: 'public' } | { kind: 'gate'; group: string };

const GROUP_PATTERN = /^[a-z][a-z_]{0,62}$/;
const RESERVED_GROUPS = new Set(['any', 'open', 'close']);

/** Parse trusted route metadata once, when the production kernel is composed. */
export function parseExposure(detail: unknown): Exposure {
  const metadata =
    typeof detail === 'object' && detail !== null && !Array.isArray(detail)
      ? (detail as Record<string, unknown>)
      : undefined;
  const value = metadata?.['x-exposure'];
  if (value === 'public') return { kind: 'public' };
  if (typeof value === 'string' && value.startsWith('gate:')) {
    const group = value.slice(5);
    if (GROUP_PATTERN.exec(group)?.[0] === group && !RESERVED_GROUPS.has(group)) return { kind: 'gate', group };
  }

  const route = typeof metadata?.operationId === 'string' ? metadata.operationId : '<unnamed route>';
  throw new Error(`${route}: routes declare x-exposure as public or gate:<group> with a valid, non-reserved group`);
}
