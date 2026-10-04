import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId } from '../work/read-contract.ts';

/** Clients name one admitted resource; its owner supplies the grain. */
export const targetRef = readId;
export const targetBase = t.Union([t.Literal('work'), t.Literal('realization'),
  t.Literal('release'), t.Literal('occurrence'), t.Literal('resource'), t.Literal('projection')]);
export type Base = Static<typeof targetBase>;

/** Includes structural owner types alongside up to 32 semantic component types. */
export const MAX_TARGET_TYPES = 64;
// Provisioning's immutable Agent anchor predates UUID-only revision addresses.
export const targetRevision = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}(?:-agent-revision)?$' });

export const resolvedTarget = t.Object({ resource: targetRef, base: targetBase,
  types: t.Array(t.String(), { maxItems: MAX_TARGET_TYPES, uniqueItems: true }), work: t.Nullable(readId),
  revision: targetRevision, disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]) },
{ additionalProperties: false });
export type ResolvedTarget = Static<typeof resolvedTarget>;

export type Capability = 'review' | 'rating' | 'discussion' | 'collection-member'
  | 'library-status' | 'progress' | 'continuity' | 'spoiler-boundary' | 'suitability' | 'session' | 'report';
/** A projection is one subject within a frame: it takes the capabilities a reader or community
 * attaches to a subject, never the ones that need a Work, a position or a session. */
const allBases = ['work', 'realization', 'release', 'occurrence', 'resource', 'projection'] as const;
export const capabilityBases = {
  report: allBases, review: allBases, rating: allBases, discussion: allBases,
  'collection-member': allBases, 'library-status': ['work'], progress: ['occurrence'],
  continuity: ['work', 'realization', 'occurrence'], 'spoiler-boundary': ['occurrence'],
  suitability: allBases,
  session: ['work', 'realization', 'release', 'occurrence'],
} as const satisfies Record<Capability, readonly Base[]>;

export function capabilityPath(resource: string, capability: Capability): string {
  if (capability === 'suitability') return `/v1/suitability/${resource.slice(-36)}`;
  return `/v1/resources/${resource.slice(-36)}/${capability}`;
}
