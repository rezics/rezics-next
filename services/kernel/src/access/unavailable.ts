/** Access could not finish; absence of evidence is not evidence of a denial. */
export class AccessUnavailableError extends Error {
  constructor(readonly reason: 'deadline' | 'overloaded' | 'contention') {
    super(`Access unavailable: ${reason}`);
    this.name = 'AccessUnavailableError';
  }
}

export function requireAccessDeadline(deadline: number): void {
  if (Number.isFinite(deadline) && Date.now() >= deadline) throw new AccessUnavailableError('deadline');
}

/** Constant-time classification shared by all Access failure boundaries. */
export function throwAccessUnavailable(error: unknown, deadline?: number): void {
  if (error instanceof AccessUnavailableError) throw error;
  if (deadline !== undefined) requireAccessDeadline(deadline);
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '57014' || (error instanceof Error && /query read timeout/i.test(error.message)))
    throw new AccessUnavailableError('deadline');
  if (code === '40001' || code === '40P01') throw new AccessUnavailableError('contention');
  if (
    (typeof code === 'string' && /^(?:08|53)/.test(code)) ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    (error instanceof Error &&
      /timeout exceeded when trying to connect|connection (?:acquisition )?timeout/i.test(error.message))
  )
    throw new AccessUnavailableError('overloaded');
}
