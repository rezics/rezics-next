const values = new WeakMap<object, { value: unknown }>();

/** Compute a module value on first use, preserving identity even for null and undefined. */
export function memoizedValue<T>(key: object, create: () => T): T {
  let cached = values.get(key);
  if (!cached) {
    cached = { value: create() };
    values.set(key, cached);
  }
  return cached.value as T;
}
