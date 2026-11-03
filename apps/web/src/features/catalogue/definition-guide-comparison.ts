import type { PropertyDefinition } from '@rezics/definitions';
import type { GuideFailure, GuideRelease } from './definition-guide';

export const guideCompareValue = 'current';
export type GuideFieldAspect = 'datatype' | 'multiplicity' | 'targets' | 'units' | 'qualifiers' | 'disclosure';

export type GuideComparisonSide =
  | { status: GuideFailure; digest?: string }
  | {
      status: 'available';
      digest: string;
      release: GuideRelease;
      admitted: boolean;
      field?: PropertyDefinition;
    };

export type GuideComparison = {
  type: string;
  property: string;
  pinned: GuideComparisonSide;
  current: GuideComparisonSide;
};

type NativeShape = {
  datatype: string;
  multivalued: boolean;
  targets: string[];
  units: string[];
  disclosure?: 'sourceOrConsent';
};

function ids(value: readonly string[] | undefined) {
  return value ?? [];
}

function sameIds(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  const a = ids(left);
  const b = ids(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function nativeShape(definition: PropertyDefinition | undefined): NativeShape | undefined {
  if (!definition) return;
  return {
    datatype: definition.datatype,
    multivalued: definition.multivalued,
    targets: ids(definition.targets),
    units: ids(definition.units),
    ...(definition.disclosure === 'sourceOrConsent' ? { disclosure: 'sourceOrConsent' as const } : {}),
  };
}

function shapesDiffer(left: NativeShape | undefined, right: NativeShape | undefined) {
  if (left === undefined && right === undefined) return false;
  if (left === undefined || right === undefined) return true;
  return (
    left.datatype !== right.datatype ||
    left.multivalued !== right.multivalued ||
    !sameIds(left.targets, right.targets) ||
    !sameIds(left.units, right.units) ||
    left.disclosure !== right.disclosure
  );
}

function qualifierNative(release: GuideRelease, id: string) {
  return nativeShape(release.properties[id]);
}

function qualifiersDiffer(pinned: PropertyDefinition, current: PropertyDefinition, left: GuideRelease, right: GuideRelease) {
  if (!sameIds(pinned.qualifiers, current.qualifiers)) return true;
  return pinned.qualifiers.some((id) => shapesDiffer(qualifierNative(left, id), qualifierNative(right, id)));
}

export function comparisonField(release: GuideRelease, typeId: string, property: string) {
  const field = Object.hasOwn(release.properties, property) ? release.properties[property] : undefined;
  return {
    admitted: Boolean(release.types[typeId]?.properties.includes(property) && field),
    ...(field ? { field } : {}),
  };
}

export function comparisonDigestsMatch(comparison: GuideComparison) {
  return (
    comparison.pinned.status === 'available' &&
    comparison.current.status === 'available' &&
    comparison.pinned.digest === comparison.current.digest
  );
}

export function comparisonFieldRemoved(comparison: GuideComparison) {
  return (
    comparison.pinned.status === 'available' &&
    comparison.pinned.admitted &&
    comparison.current.status === 'available' &&
    !comparison.current.admitted
  );
}

/** Semantic identifiers and native values only; localized labels never count as a definition change. */
export function comparisonAspects(comparison: GuideComparison): Set<GuideFieldAspect> {
  const changed = new Set<GuideFieldAspect>();
  if (comparison.pinned.status !== 'available' || comparison.current.status !== 'available') return changed;
  if (comparisonDigestsMatch(comparison) || !comparison.pinned.admitted || !comparison.current.admitted) return changed;
  const pinned = comparison.pinned.field;
  const current = comparison.current.field;
  if (!pinned || !current) return changed;
  if (pinned.datatype !== current.datatype) changed.add('datatype');
  if (pinned.multivalued !== current.multivalued) changed.add('multiplicity');
  if (!sameIds(pinned.targets, current.targets)) changed.add('targets');
  if (!sameIds(pinned.units, current.units)) changed.add('units');
  if (pinned.disclosure !== current.disclosure) changed.add('disclosure');
  if (qualifiersDiffer(pinned, current, comparison.pinned.release, comparison.current.release)) changed.add('qualifiers');
  return changed;
}
