import { AccessUnavailableError, CommandUnavailableError } from './contract/errors.ts';
export { AccessUnavailableError, CommandUnavailableError } from './contract/errors.ts';

/** Constant-time classification shared by Access, commands, HTTP, and durable work. */
export function classifyUnavailability(error: unknown): CommandUnavailableError['reason'] | undefined {
  if (error instanceof AccessUnavailableError || error instanceof CommandUnavailableError) return error.reason;
  // An expired AbortSignal.timeout is the request budget running out, not a credential refusal.
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError')
    return 'deadline';
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '57014' || (error instanceof Error && /query read timeout/i.test(error.message))) return 'deadline';
  if (code === '40001' || code === '40P01' || code === '55P03') return 'contention';
  if (
    (typeof code === 'string' && /^(?:08|53)/.test(code)) ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    (error instanceof Error &&
      /timeout exceeded when trying to connect|connection (?:acquisition )?timeout/i.test(error.message))
  )
    return 'overloaded';
  return undefined;
}

export function requireAccessDeadline(deadline: number): void {
  if (Number.isFinite(deadline) && Date.now() >= deadline) throw new AccessUnavailableError('deadline');
}

export function throwAccessUnavailable(error: unknown, deadline?: number): void {
  if (error instanceof AccessUnavailableError) throw error;
  if (deadline !== undefined) requireAccessDeadline(deadline);
  const reason = classifyUnavailability(error);
  if (reason === 'deadline' || reason === 'contention' || reason === 'overloaded')
    throw new AccessUnavailableError(reason);
}
