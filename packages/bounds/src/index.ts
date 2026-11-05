/** Finite dimensions for describing admitted work. Values carry no dispatch authority. */
export const BOUND_AXES = Object.freeze([
  'candidateKeys',
  'nativeRows',
  'identityMetadataRows',
  'emptySeeks',
  'nativePoints',
  'witnessKeys',
  'statements',
  'bytes',
  'engineRequests',
] as const);

export type BoundAxis = (typeof BOUND_AXES)[number];
export type Bound = Readonly<Record<BoundAxis, number>>;

const axisSet = new Set<string>(BOUND_AXES);

/** Validate and defensively freeze a complete declaration. Unknown, omitted and unsafe values refuse. */
export function declareBound(value: unknown): Bound {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid bound declaration');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError('Invalid bound declaration');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== BOUND_AXES.length || keys.some((key) => typeof key !== 'string' || !axisSet.has(key)))
    throw new TypeError('Invalid bound declaration axes');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const axis of BOUND_AXES) {
    const descriptor = descriptors[axis];
    if (
      !descriptor ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'number' ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    )
      throw new TypeError(`Invalid bound declaration value: ${axis}`);
  }
  return Object.freeze(Object.fromEntries(BOUND_AXES.map((axis) => [axis, descriptors[axis]!.value])) as Bound);
}

/** Return whether a value is a complete finite declaration. */
export function isBound(value: unknown): value is Bound {
  try {
    declareBound(value);
    return true;
  } catch {
    return false;
  }
}

/** Compose declarations, refusing any input or result outside the safe-integer range. */
export function sumBounds(...parts: readonly Bound[]): Bound {
  const validated = parts.map(declareBound);
  const total = Object.fromEntries(BOUND_AXES.map((axis) => [axis, 0])) as Record<BoundAxis, number>;
  for (const part of validated)
    for (const axis of BOUND_AXES) {
      const value = total[axis] + part[axis];
      if (!Number.isSafeInteger(value)) throw new TypeError('Bound declaration overflow');
      total[axis] = value;
    }
  return Object.freeze(total);
}

/** Repeat a complete declaration a finite number of times with overflow-safe composition. */
export function repeatBound(bound: Bound, count: number): Bound {
  const value = declareBound(bound);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('Invalid bound multiplicity');
  let result = declareBound(Object.fromEntries(BOUND_AXES.map((axis) => [axis, 0])));
  let addend = value;
  let remaining = count;
  while (remaining > 0) {
    if (remaining % 2 === 1) result = sumBounds(result, addend);
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) addend = sumBounds(addend, addend);
  }
  return result;
}

/** Compare a declaration with its complete static ceiling. Invalid declarations throw. */
export function withinCeiling(bound: Bound, ceiling: Bound): boolean {
  const actual = declareBound(bound);
  const maximum = declareBound(ceiling);
  return BOUND_AXES.every((axis) => actual[axis] <= maximum[axis]);
}
