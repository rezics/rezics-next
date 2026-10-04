import { typeFrameDimensions, typeRegistry } from '../../../../../packages/model/src/generated/types.ts';
import type { Base, ResolvedTarget } from '../target/contract.ts';

/** Every coordinate of a frame, applicability or Statement belongs to exactly one dimension. */
export type FrameDimension = 'work' | 'realization' | 'release' | 'position' | (typeof typeFrameDimensions)[number];

/** Structural grains fix their own dimension; descriptive types declare theirs in the type registry. */
const structuralDimensions = { work: 'work', realization: 'realization', release: 'release',
  occurrence: 'position' } as const satisfies Partial<Record<Base, FrameDimension>>;

const descriptiveDimensions = new Map<string, FrameDimension>(
  (Object.values(typeRegistry) as readonly { type: string; frameDimension?: FrameDimension }[])
    .flatMap(entry => entry.frameDimension ? [[entry.type, entry.frameDimension] as const] : []));

/** The dimension a resolved target occupies, or null when it cannot be a coordinate: a type without
 * a dimension (Realms, Spaces, Contexts, Agents and so on), several conflicting dimensions, or a Projection. */
export function dimensionOf(target: Pick<ResolvedTarget, 'base' | 'types'>): FrameDimension | null {
  if (target.base in structuralDimensions) return structuralDimensions[target.base as keyof typeof structuralDimensions];
  if (target.base !== 'resource') return null;
  const found = new Set(target.types.flatMap(type => descriptiveDimensions.get(type) ?? []));
  return found.size === 1 ? [...found][0]! : null;
}

export interface Coordinate {
  iri: string;
  dimension: FrameDimension;
  /** The Work a Work, position, release or realization lies in; Structure ownership is the only containment a frame uses. */
  work?: string | null;
  /** Disclosed active in-continuity memberships, loaded once for the request's Works. */
  continuities?: readonly string[];
  /** The Structure groups a position lies in, nearest first, loaded once for the request's position. */
  ancestors?: readonly string[];
}

/** A target as a typed coordinate; null when its type has no dimension. */
export function coordinateOf(target: Pick<ResolvedTarget, 'resource' | 'base' | 'types' | 'work'>): Coordinate | null {
  const dimension = dimensionOf(target);
  return dimension ? { iri: target.resource, dimension, work: target.work } : null;
}

/** What one "X in F" holds once. Decision 51 lists a Work or Structure position as one slot and a release or
 * realization as another; the four coordinate kinds stay distinct because acceptance policies persist them. */
export type FrameSlot = 'structure' | 'edition' | Exclude<FrameDimension, 'work' | 'position' | 'release' | 'realization'>;

export function slotOf(dimension: FrameDimension): FrameSlot {
  return dimension === 'work' || dimension === 'position' ? 'structure'
    : dimension === 'release' || dimension === 'realization' ? 'edition' : dimension;
}

/** A frame whose coordinates cannot name one "X in F". */
export class FrameRefused extends Error {
  constructor(readonly reason: 'slot-repeated' | 'work-mismatch') {
    super(reason === 'slot-repeated' ? 'A frame has at most one coordinate per slot'
      : 'A frame names more than one Work');
  }
}

/** The Work a coordinate lies in: a Work is its own. */
const workOf = (coordinate: Coordinate) => coordinate.dimension === 'work' ? coordinate.iri : coordinate.work ?? null;

/** The one Work a normalized frame lies in, when any of its coordinates names one. */
export const frameWork = (frames: readonly Coordinate[]): string | null => frames.flatMap(frame => workOf(frame) ?? [])[0] ?? null;

/** The one canonical coordinate set of a frame, so every "X in F" has one identity. A slot holds one coordinate,
 * except that a Work may accompany its own position; every coordinate must lie in the same Work; and a Work that a
 * position, release or realization already implies is dropped. */
export function normalizeFrame(coordinates: readonly Coordinate[]): Coordinate[] {
  const slots = new Map<FrameSlot, Coordinate[]>();
  for (const coordinate of coordinates) {
    const slot = slotOf(coordinate.dimension);
    slots.set(slot, [...slots.get(slot) ?? [], coordinate]);
  }
  for (const [slot, held] of slots) {
    const workWithPosition = slot === 'structure' && held.length === 2
      && held.some(coordinate => coordinate.dimension === 'work') && held.some(coordinate => coordinate.dimension === 'position');
    if (held.length > 1 && !workWithPosition) throw new FrameRefused('slot-repeated');
  }
  if (new Set(coordinates.flatMap(coordinate => workOf(coordinate) ?? [])).size > 1) throw new FrameRefused('work-mismatch');
  const implied = coordinates.some(coordinate => coordinate.dimension !== 'work' && workOf(coordinate));
  return coordinates.filter(coordinate => !(implied && coordinate.dimension === 'work'));
}

/** Structural owner types take precedence over descriptive dimensions, as dimensionOf does. */
export const structuralCoordinateTypes: readonly (readonly [string, FrameDimension])[] = [
  ['https://schema.org/CreativeWork', 'work'], [`https://rezics.com/vocab/TextContribution`, 'realization'],
  [`https://rezics.com/vocab/Realization`, 'realization'], [`https://rezics.com/vocab/Release`, 'release'],
  [`https://rezics.com/vocab/FixedRelease`, 'release'], ['https://schema.org/ListItem', 'position'],
];
export const coordinateTypes: readonly (readonly [string, FrameDimension])[] = [
  ...structuralCoordinateTypes,
  ...[...descriptiveDimensions].map(([type, dimension]) => [type, dimension] as const),
];

/** The dimension of a Resource known only by its types, as a write that names applicability by IRI has it:
 * structural owner types first, then the registry, as dimensionOf does with a target's grain. */
export function dimensionOfTypes(types: readonly string[]): FrameDimension | null {
  const structural = new Set(structuralCoordinateTypes.flatMap(([type, dimension]) => types.includes(type) ? [dimension] : []));
  if (structural.size) return structural.size === 1 ? [...structural][0]! : null;
  return dimensionOf({ base: 'resource', types: [...types] });
}
