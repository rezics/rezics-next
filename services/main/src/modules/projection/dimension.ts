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
  /** The Work a position lies in; Structure ownership is the only containment a frame uses. */
  work?: string | null;
  /** Disclosed active in-continuity memberships, loaded once for the request's Works. */
  continuities?: readonly string[];
}

/** A target as a typed coordinate; null when its type has no dimension. */
export function coordinateOf(target: Pick<ResolvedTarget, 'resource' | 'base' | 'types' | 'work'>): Coordinate | null {
  const dimension = dimensionOf(target);
  return dimension ? { iri: target.resource, dimension, work: target.work } : null;
}

/** Whether a Statement's or relation occurrence's applicability holds throughout a frame.
 * Values in one dimension combine with OR (true in Canon or in Legends); dimensions combine with
 * AND (in continuity C and in chapter 3). A dimension the applicability does not name leaves the
 * frame unconstrained, so empty applicability covers every frame; a dimension it names needs the
 * frame to hold a coordinate there. A position frame is also covered by applicability naming its Work. */
export function covers(applicability: readonly Coordinate[], frames: readonly Coordinate[]): boolean {
  const frame = new Map<FrameDimension, Coordinate>();
  for (const coordinate of frames) {
    if (frame.has(coordinate.dimension)) throw new RangeError('A frame has at most one coordinate per dimension');
    frame.set(coordinate.dimension, coordinate);
  }
  const named = new Map<FrameDimension, Set<string>>();
  for (const { dimension, iri } of applicability) named.set(dimension, (named.get(dimension) ?? new Set()).add(iri));
  return [...named].every(([dimension, values]) => {
    const exact = frame.get(dimension);
    if (exact && values.has(exact.iri)) return true;
    const position = frame.get('position');
    if (dimension === 'work' && !!position?.work && values.has(position.work)) return true;
    return dimension === 'continuity' && !exact && [frame.get('work'), position]
      .some(coordinate => coordinate?.continuities?.some(continuity => values.has(continuity)));
  });
}

/** More constrained dimensions first, then exact coordinates before inherited coverage.
 * Alternatives in one dimension never inflate specificity. */
export function specificity(applicability: readonly Coordinate[], frames: readonly Coordinate[]) {
  const dimensions = new Set(applicability.map(coordinate => coordinate.dimension)).size;
  const exact = new Set(applicability.filter(coordinate => frames.some(frame =>
    frame.dimension === coordinate.dimension && frame.iri === coordinate.iri)).map(coordinate => coordinate.dimension)).size;
  return { dimensions, exact, score: dimensions * 16 + exact };
}

/** Structural owner types take precedence over descriptive dimensions, as dimensionOf does. */
export const coordinateTypes: readonly (readonly [string, FrameDimension])[] = [
  ['https://schema.org/CreativeWork', 'work'], [`https://rezics.com/vocab/TextContribution`, 'realization'],
  [`https://rezics.com/vocab/Realization`, 'realization'], [`https://rezics.com/vocab/Release`, 'release'],
  [`https://rezics.com/vocab/FixedRelease`, 'release'], ['https://schema.org/ListItem', 'position'],
  ...[...descriptiveDimensions].map(([type, dimension]) => [type, dimension] as const),
];
