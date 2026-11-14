import { MapResult, Mapping, StepMap, type Mappable } from '@tiptap/pm/transform';

// Native leaf/recovery evaluation adapts prosemirror-transform 1.12.4 src/map.ts (MIT).
// Exact source, version and complete notice are in ../../THIRD_PARTY_NOTICES.md.
// This private evaluator changes no StepMap or history Item. Its producer is the native history command.
type Summary = { low: number; high: number; delta: number; minimum: number; maximum: number };
type Tree = { from: number; to: number; summary: Summary; left?: Tree; right?: Tree };
type RuntimeResult = MapResult & { readonly delInfo: number; readonly recover: number | null };
type RecoverableMap = StepMap & { recover(value: number): number };
const NativeResult = MapResult as unknown as { new (position: number, deletion: number, recover: null): MapResult };

function summary(map: StepMap): Summary | null {
  if (
    Object.getPrototypeOf(map) !== StepMap.prototype ||
    ['map', 'mapResult', 'forEach', 'recover'].some((key) => Object.hasOwn(map, key))
  )
    return null;
  let low = Infinity,
    high = -Infinity,
    delta = 0,
    previous = -Infinity,
    valid = true;
  map.forEach((from, to, nextFrom, nextTo) => {
    if (
      ![from, to, nextFrom, nextTo, to - from, nextTo - nextFrom].every(Number.isSafeInteger) ||
      from < previous ||
      to < from ||
      nextTo < nextFrom
    )
      valid = false;
    low = Math.min(low, from);
    high = Math.max(high, to);
    delta += nextTo - nextFrom - (to - from);
    previous = to;
  });
  return valid && Number.isSafeInteger(delta)
    ? { low, high, delta, minimum: Math.min(0, delta), maximum: Math.max(0, delta) }
    : null;
}

function compose(a: Summary, b: Summary): Summary | null {
  if (a.low === Infinity) return b;
  if (b.low === Infinity) return a;
  const result = {
    low: Math.min(a.low, b.low),
    high: Math.max(a.high, b.high - a.delta),
    delta: a.delta + b.delta,
    minimum: Math.min(a.minimum, a.delta + b.minimum),
    maximum: Math.max(a.maximum, a.delta + b.maximum),
  };
  return Object.values(result).every(Number.isSafeInteger) ? result : null;
}

class Sequence {
  readonly roots: Tree[] = [];
  count = 0;
  supported = true;
  private last: StepMap | undefined;
  update(maps: readonly StepMap[]): boolean {
    // The owned native producer appends. Shrink/replacement is not an indexed producer.
    if (maps.length < this.count || (this.count && maps[this.count - 1] !== this.last)) return false;
    while (this.count < maps.length) {
      const index = this.count++;
      const item = summary(maps[index]!);
      if (!item) {
        this.supported = false;
        break;
      }
      let node: Tree = { from: index, to: index + 1, summary: item };
      while (this.roots.length && this.roots.at(-1)!.to - this.roots.at(-1)!.from === node.to - node.from) {
        const left = this.roots.pop()!;
        const summary = compose(left.summary, node.summary);
        if (!summary) {
          this.supported = false;
          return false;
        }
        node = { from: left.from, to: node.to, summary, left, right: node };
      }
      this.roots.push(node);
    }
    this.last = maps[this.count - 1];
    return this.supported;
  }
}

class Mirrors {
  private read = 0;
  private pairs = new Map<number, number>();
  update(values: readonly number[]) {
    while (this.read + 1 < values.length) {
      const first = values[this.read++]!,
        second = values[this.read++]!;
      if (!this.pairs.has(first)) this.pairs.set(first, second);
      if (!this.pairs.has(second)) this.pairs.set(second, first);
    }
  }
  get(index: number) {
    return this.pairs.get(index);
  }
}

export class NativeMappingIndex {
  private sequences = new WeakMap<readonly StepMap[], Sequence>();
  private mirrors = new WeakMap<readonly number[], Mirrors>();
  leafVisits = 0;
  skippedMaps = 0;

  mappable(mapping: Mappable): Mappable {
    if (
      Object.getPrototypeOf(mapping) !== Mapping.prototype ||
      Object.hasOwn(mapping, 'map') ||
      Object.hasOwn(mapping, 'mapResult')
    )
      return mapping;
    const native = mapping as Mapping;
    const { maps, from, to } = native;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > maps.length)
      return mapping;
    let sequence = this.sequences.get(maps);
    if (!sequence) {
      sequence = new Sequence();
      this.sequences.set(maps, sequence);
    }
    if (!sequence.update(maps)) return mapping;
    const evaluate = (initial: number, assoc = 1): MapResult => {
      const { from, to } = native;
      if (
        !Number.isSafeInteger(initial) ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        native.maps !== maps ||
        from < 0 ||
        to < from ||
        to > maps.length ||
        !sequence.update(maps)
      )
        return native.mapResult(initial, assoc);
      const values = (native as Mapping & { mirror?: readonly number[] }).mirror;
      let mirrors: Mirrors | undefined;
      if (values) {
        mirrors = this.mirrors.get(values);
        if (!mirrors) {
          mirrors = new Mirrors();
          this.mirrors.set(values, mirrors);
        }
        mirrors.update(values);
      }
      let position = initial,
        deletion = 0,
        index = from;
      const walk = (node: Tree) => {
        if (index >= to || index >= node.to || node.from >= to || node.to <= from) return;
        const range = node.summary;
        const safe =
          Number.isSafeInteger(position) &&
          Number.isSafeInteger(position + range.minimum) &&
          Number.isSafeInteger(position + range.maximum);
        if (
          safe &&
          node.from >= index &&
          node.from >= from &&
          node.to <= to &&
          (position < range.low || position > range.high)
        ) {
          if (position > range.high) position += range.delta;
          this.skippedMaps += node.to - node.from;
          index = node.to;
          return;
        }
        if (node.left && node.right) {
          walk(node.left);
          walk(node.right);
          return;
        }
        this.leafVisits++;
        const result = maps[node.from]!.mapResult(position, assoc) as RuntimeResult;
        const mirror = result.recover !== null ? mirrors?.get(node.from) : undefined;
        if (result.recover !== null && mirror !== undefined && mirror > node.from && mirror < to) {
          position = (maps[mirror] as RecoverableMap).recover(result.recover);
          index = mirror + 1;
        } else {
          deletion |= result.delInfo;
          position = result.pos;
          index = node.to;
        }
      };
      for (const root of sequence.roots) walk(root);
      return new NativeResult(position, deletion, null);
    };
    return { map: (position, assoc) => evaluate(position, assoc).pos, mapResult: evaluate };
  }
}

let active: NativeMappingIndex | null = null;

export function indexedNativeMapping(mapping: Mappable): Mappable {
  return active?.mappable(mapping) ?? mapping;
}

/** Synchronous, reentrant command scope; no native prototype or shared history mutation. */
export function withNativeMappingIndex<T>(operation: (index: NativeMappingIndex) => T): T {
  const previous = active;
  active = new NativeMappingIndex();
  try {
    return operation(active);
  } finally {
    active = previous;
  }
}
