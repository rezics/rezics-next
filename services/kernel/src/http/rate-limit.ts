export type RateLimitFamily = 'write' | 'upload' | 'report' | 'correspondence' | 'search' | 'provider' | 'address';

export type RateLimitDeclaration = {
  readonly family: RateLimitFamily;
  readonly units: 1 | 'commands';
};

function validateDeclaration(input: unknown): RateLimitDeclaration {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('Rate limit declaration must be an object');
  const { family, units } = input as RateLimitDeclaration;
  if (!['write', 'upload', 'report', 'correspondence', 'search', 'provider', 'address'].includes(family))
    throw new TypeError('Unknown rate limit family');
  if (units !== 1 && units !== 'commands') throw new TypeError('Unknown rate limit units');
  return { family, units };
}

/** Snapshots trusted server metadata for a mounted route's detail['x-rate-limit']. */
export function defineRateLimit(input: RateLimitDeclaration): Readonly<RateLimitDeclaration> {
  return Object.freeze(validateDeclaration(input));
}

/**
 * Resolves cost after native body validation, before any spend or command effects.
 * The declaration comes exclusively from registered route hooks, never request JSON or headers.
 * This helper neither charges a budget nor proves that a request was charged.
 */
export function rateLimitUnits(declaration: RateLimitDeclaration, validatedBody: unknown): number {
  const { units } = validateDeclaration(declaration);
  if (units === 1) return 1;
  if (typeof validatedBody !== 'object' || validatedBody === null || Array.isArray(validatedBody))
    throw new TypeError('Commands rate limit requires a validated command body');
  const commands = (validatedBody as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) throw new TypeError('Commands rate limit requires an array');
  const count = commands.length;
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new RangeError('Commands rate limit requires 1 to 100 commands');
  return count;
}
