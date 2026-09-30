import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId } from '../work/read-contract.ts';

/** Clients name one admitted resource; its owner supplies the grain. */
export const targetRef = readId;
export const targetBase = t.Union([t.Literal('work'), t.Literal('realization'),
  t.Literal('release'), t.Literal('occurrence'), t.Literal('resource')]);
export type Base = Static<typeof targetBase>;

/** Includes structural owner types alongside up to 32 semantic component types. */
export const MAX_TARGET_TYPES = 64;

export const resolvedTarget = t.Object({ resource: targetRef, base: targetBase,
  types: t.Array(t.String(), { maxItems: MAX_TARGET_TYPES, uniqueItems: true }), work: t.Nullable(readId),
  revision: readId, disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]) },
{ additionalProperties: false });
export type ResolvedTarget = Static<typeof resolvedTarget>;

export type Capability = 'review' | 'rating' | 'discussion' | 'collection-member'
  | 'library-status' | 'progress' | 'continuity' | 'spoiler-boundary';
const allBases = ['work', 'realization', 'release', 'occurrence', 'resource'] as const;
export const capabilityBases = {
  review: ['work', 'release'], rating: ['work', 'release'], discussion: allBases,
  'collection-member': allBases, 'library-status': ['work'], progress: ['occurrence'],
  continuity: ['work', 'realization', 'occurrence'], 'spoiler-boundary': ['occurrence'],
} as const satisfies Record<Capability, readonly Base[]>;

export function capabilityPath(resource: string, capability: Capability): string {
  return `/v1/resources/${resource.slice(-36)}/${capability}`;
}
