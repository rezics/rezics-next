import defaults from '../defaults.json';

/** Pure defaults and parsing live here so settings consumers do not import the runtime composition. */
export const defaultPolicy = defaults.policy;
export type ControlPolicy = typeof defaultPolicy;

/** Merge individual leaves, reject unknown names, and keep policy numbers finite and integral. */
export function readControlPolicy(value: unknown = {}): ControlPolicy {
  function merge(base: Record<string, unknown>, overrides: unknown, path: string): Record<string, unknown> {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
      throw new Error(`${path} must be an object`);
    const input = overrides as Record<string, unknown>;
    for (const key of Object.keys(input)) if (!Object.hasOwn(base, key)) throw new Error(`unknown ${path}.${key}`);
    return Object.fromEntries(
      Object.entries(base).map(([key, fallback]) => {
        const label = `${path}.${key}`;
        const candidate = input[key] === undefined ? fallback : input[key];
        if (typeof fallback === 'object') return [key, merge(fallback as Record<string, unknown>, candidate, label)];
        // A zero memory floor disables only the memory guard; all other policies must be positive.
        const minimum = label === 'policy.capacity.minAvailableMiB' ? 0 : 1;
        if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < minimum)
          throw new Error(`invalid ${label}`);
        return [key, candidate];
      }),
    );
  }
  return merge(defaultPolicy, value, 'policy') as ControlPolicy;
}
