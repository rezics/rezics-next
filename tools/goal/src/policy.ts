import defaults from '../defaults.json';

/** Pure defaults and parsing live here so settings consumers do not import the runtime composition. */
export const defaultPolicy = defaults.policy;
export type ControlPolicy = typeof defaultPolicy;

/** Merge leaves and reject unknown names; fractional and list policies have field-specific validation. */
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
        if (Array.isArray(fallback)) {
          // Tool retries may deliberately wait zero milliseconds; settlement pauses remain positive.
          const minimum = label === 'policy.worker.toolRetryBackoffMs' ? 0 : 1;
          if (
            !Array.isArray(candidate) ||
            !candidate.length ||
            Array.from(candidate).some((delay) => !Number.isSafeInteger(delay) || delay < minimum)
          )
            throw new Error(`invalid ${label}`);
          return [key, [...candidate]];
        }
        if (typeof fallback === 'object') return [key, merge(fallback as Record<string, unknown>, candidate, label)];
        if (label === 'policy.workerResources.minimumMemoryFraction' || label === 'policy.containers.maxAgeHours') {
          const fraction = label === 'policy.workerResources.minimumMemoryFraction';
          if (
            typeof candidate !== 'number' ||
            !Number.isFinite(candidate) ||
            (fraction ? candidate <= 0 || candidate > 1 : candidate < 0)
          )
            throw new Error(`invalid ${label}`);
          return [key, candidate];
        }
        // Zero disables the host memory floor or the extra worker memory reserve.
        const minimum = ['policy.capacity.minAvailableMiB', 'policy.workerResources.memoryReserveGiB'].includes(label)
          ? 0
          : 1;
        if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < minimum)
          throw new Error(`invalid ${label}`);
        return [key, candidate];
      }),
    );
  }
  const policy = merge(defaultPolicy, value, 'policy') as ControlPolicy;
  for (const [label, percent] of [
    ['manager.continuationBudgetPercent', policy.manager.continuationBudgetPercent],
    ['pacing.alertUnusedPercent', policy.pacing.alertUnusedPercent],
  ] as const)
    if (percent > 100) throw new Error(`invalid policy.${label}`);
  if (policy.host.maxBackoffMs < policy.host.minBackoffMs)
    throw new Error('policy.host.maxBackoffMs must be at least policy.host.minBackoffMs');
  return policy;
}
