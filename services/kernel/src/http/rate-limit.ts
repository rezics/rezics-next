export type RateLimitFamily = 'write' | 'upload' | 'report' | 'correspondence' | 'search' | 'provider' | 'address';

export type RateLimitDeclaration = {
  readonly family: RateLimitFamily;
  /** One ordinary unit, or the validated command array's cardinality (1 to 100). */
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

/**
 * Snapshots trusted server metadata for a mounted route's detail['x-rate-limit'].
 * Read-only routes omit write-rate metadata; their owning policy uses the trusted route/action catalogue.
 */
export function defineRateLimit(input: RateLimitDeclaration): Readonly<RateLimitDeclaration> {
  return Object.freeze(validateDeclaration(input));
}

/**
 * Resolves cost after native body validation, before any spend or command effects.
 * The result is the full request cost: charge a bulk once, without adding an ordinary write unit.
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
