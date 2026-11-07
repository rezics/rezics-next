// A tagged canonical tree preserves bigint/undefined without collisions with user JSON objects.
type Tree = [string, unknown?];
export function tree(value: unknown, scalarTag: 'scalar' | 'value' = 'scalar'): Tree {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (Array.isArray(value)) return ['array', value.map((child) => tree(child, scalarTag))];
  if (value !== null && typeof value === 'object')
    return [
      'object',
      Object.keys(value)
        .sort()
        .map((key) => [key, tree((value as Record<string, unknown>)[key], scalarTag)]),
    ];
  requireValue(
    value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)),
  );
  return [scalarTag, value];
}
function untree(value: Tree): unknown {
  switch (value[0]) {
    case 'undefined':
      return undefined;
    case 'bigint':
      return BigInt(value[1] as string);
    case 'array':
      return (value[1] as Tree[]).map(untree);
    case 'object':
      return Object.fromEntries((value[1] as [string, Tree][]).map(([key, entry]) => [key, untree(entry)]));
    case 'value': // Existing consumer_work encoding.
    case 'scalar':
      return value[1];
    default:
      throw new TypeError('Invalid custody encoding');
  }
}
export const encode = (value: unknown) => JSON.stringify(tree(value));
export const decode = <T>(value: string): T => untree(JSON.parse(value) as Tree) as T;

export function requireValue(value: unknown): asserts value {
  if (!value) throw new TypeError('Invalid public filter custody input');
}
