// A tagged canonical tree preserves bigint/undefined without collisions with user JSON objects.
type Tree = [string, unknown?];
type ScalarTag = 'scalar' | 'value';
export function tree(value: unknown, scalarTag: ScalarTag = 'scalar'): Tree {
  return pack(value, scalarTag);
}
function pack(value: unknown, scalarTag: ScalarTag, references?: ReadonlyMap<object, number>): Tree {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (typeof value === 'object' && value !== null) {
    const reference = references?.get(value);
    if (reference !== undefined) return ['reference', reference];
  }
  if (Array.isArray(value)) return ['array', value.map((child) => pack(child, scalarTag, references))];
  if (value !== null && typeof value === 'object')
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, pack((value as Record<string, unknown>)[key], scalarTag, references)]),
    ];
  requireValue(
    value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)),
  );
  return [scalarTag, value];
}
function untree(value: Tree, references: readonly unknown[] = []): unknown {
  switch (value[0]) {
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(value[1] as string);
    case 'reference': {
      const index = value[1];
      requireValue(typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < references.length);
      return references[index];
    }
    case 'array':
      return (value[1] as Tree[]).map((entry) => untree(entry, references));
    case 'object':
      return Object.fromEntries((value[1] as [string, Tree][]).map(([key, entry]) => [key, untree(entry, references)]));
    case 'value': // Existing consumer_work encoding.
    case 'scalar':
      return value[1];
    default:
      throw new TypeError('Invalid custody encoding');
  }
}
export const encode = (value: unknown) => JSON.stringify(tree(value));

/** Opt-in sharing preserves the full canonical content, including values decoded separately from legacy rows. */
export function encodeWithReferences(
  value: unknown,
  bodies: readonly object[],
  scalarTag: ScalarTag = 'scalar',
): string {
  if (bodies.length < 2) return JSON.stringify(tree(value, scalarTag));
  const references = new Map<object, number>();
  const indexes = new Map<string, number>();
  const table: Tree[] = [];
  for (const body of new Set(bodies)) {
    const packed = tree(body, scalarTag);
    const key = JSON.stringify(packed);
    let index = indexes.get(key);
    if (index === undefined) {
      index = table.length;
      table.push(packed);
      indexes.set(key, index);
    }
    references.set(body, index);
  }
  if (table.length === bodies.length) return JSON.stringify(tree(value, scalarTag));
  return JSON.stringify(['references', [table, pack(value, scalarTag, references)]]);
}

export function decode<T>(value: string): T {
  const packed = JSON.parse(value) as Tree;
  if (packed[0] !== 'references') return untree(packed) as T;
  const [table, body] = packed[1] as [Tree[], Tree];
  return untree(
    body,
    table.map((entry) => untree(entry)),
  ) as T;
}

export function requireValue(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid public filter custody input');
}

const escaped = /["\\\u0000-\u001f\ud800-\udfff]/u;
function stringBytes(text: string) {
  return escaped.test(text) ? Buffer.byteLength(JSON.stringify(text)) : 2 + Buffer.byteLength(text);
}

/** Count the canonical UTF-8 encoding while charging work. Object member order has no effect on its size. */
export function treeByteLength(value: unknown, scalarTag: 'scalar' | 'value' = 'scalar'): number {
  if (value === undefined) return '["undefined"]'.length;
  if (typeof value === 'bigint') return '["bigint",""]'.length + value.toString().length;
  if (Array.isArray(value)) {
    let size = '["array",[]]'.length + Math.max(0, value.length - 1);
    for (let i = 0; i < value.length; i++) size += i in value ? treeByteLength(value[i], scalarTag) : 'null'.length;
    return size;
  }
  if (typeof value === 'object' && value !== null) {
    let size = '["object",[]]'.length;
    const keys = Object.keys(value);
    for (const key of keys) {
      size += '[,]'.length + stringBytes(key) + treeByteLength((value as Record<string, unknown>)[key], scalarTag);
    }
    return size + Math.max(0, keys.length - 1);
  }
  const overhead = scalarTag === 'scalar' ? '["scalar",]'.length : '["value",]'.length;
  if (typeof value === 'string') return overhead + stringBytes(value);
  if (typeof value === 'number' && (scalarTag === 'value' || Number.isFinite(value)))
    return overhead + (Number.isFinite(value) ? String(value).length : 'null'.length);
  if (typeof value === 'boolean') return overhead + (value ? 'true'.length : 'false'.length);
  if (value === null) return overhead + 'null'.length;
  if (scalarTag === 'scalar') throw new TypeError('Invalid public filter custody input');
  return Buffer.byteLength(JSON.stringify([scalarTag, value]));
}
