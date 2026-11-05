import type { PolicyResidual } from '@rezics/access';

export type CollectionListFilter =
  | Readonly<{ status: 'ready'; source: 'curator'; parameters: Readonly<Record<string, never>> }>
  | Readonly<{
      status: 'ready';
      source: 'public';
      parameters: Readonly<{ policy_visibility: 'public' }>;
    }>
  | Readonly<{ status: 'unavailable' }>;

function plainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownValue(value: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Invalid residual data');
  return descriptor.value;
}

/** Lower only the two residual shapes admitted by the current indexed list profile. */
export function lowerCollectionListResidual(residual: PolicyResidual): CollectionListFilter {
  try {
    if (!plainObject(residual) || Reflect.ownKeys(residual).length !== 2) return { status: 'unavailable' };
    if (ownValue(residual, 'format') !== 'rezics-access-residual/1') return { status: 'unavailable' };
    const root = ownValue(residual, 'root');
    if (!plainObject(root)) return { status: 'unavailable' };
    const operation = ownValue(root, 'op');
    if (operation === 'constant' && Reflect.ownKeys(root).length === 2) {
      const value = ownValue(root, 'value');
      if (typeof value !== 'boolean') return { status: 'unavailable' };
      return value
        ? Object.freeze({ status: 'ready', source: 'curator', parameters: Object.freeze({}) })
        : { status: 'unavailable' };
    }
    if (
      operation === 'operand' &&
      Reflect.ownKeys(root).length === 2 &&
      ownValue(root, 'name') === 'public.floor'
    )
      return Object.freeze({
        status: 'ready',
        source: 'public',
        parameters: Object.freeze({ policy_visibility: 'public' }),
      });
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}
