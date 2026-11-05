export type Exposure = Readonly<{ kind: 'public' } | { kind: 'gate'; group: string }>;

const reservedGroups = new Set(['any', 'open', 'close']);
const routeGroup = /^[a-z][a-z_]{0,62}$/;
const openingGroup = /^[a-z][a-z_-]{0,62}$/;

const publicExposure: Exposure = Object.freeze({ kind: 'public' as const });

/** Route declarations retain their installed underscore-only grammar. */
export function isRouteExposureGroup(value: string): boolean {
  return routeGroup.exec(value)?.[0] === value && !reservedGroups.has(value);
}

/** Native opening and gate-action keys retain their underscore-or-hyphen grammar. */
export function isExposureGroup(value: string): boolean {
  return openingGroup.exec(value)?.[0] === value && !reservedGroups.has(value);
}

/** Normalize the explicit exposure value read by a trusted deployment adapter. */
export function parseExposureDeclaration(value: unknown): Exposure {
  if (value === 'public') return publicExposure;
  if (typeof value === 'string' && value.startsWith('gate:')) {
    const group = value.slice(5);
    if (isRouteExposureGroup(group)) return Object.freeze({ kind: 'gate', group });
  }
  throw new TypeError('Invalid exposure declaration');
}

/** The only gate actions a closed exposure may borrow from native Global authority. */
export function exposureAuthorityActions(group: string): readonly [string, 'gate:any'] {
  if (!isExposureGroup(group)) throw new TypeError('Invalid exposure group');
  return Object.freeze([`gate:${group}`, 'gate:any'] as [string, 'gate:any']);
}
