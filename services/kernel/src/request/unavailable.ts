/** Access could not finish; absence of evidence is not evidence of a denial. */
export class AccessUnavailableError extends Error {
  constructor(readonly reason: 'deadline' | 'overloaded' | 'contention') {
    super(`Access unavailable: ${reason}`);
    this.name = 'AccessUnavailableError';
  }
}

export class CommandUnavailableError extends Error {
  readonly reason: 'fenced' | 'moved' | 'contention' | 'deadline' | 'overloaded';
  readonly partition: number;
  readonly movedTo: string | null;
  constructor(reason: CommandUnavailableError['reason'], partition: number, movedTo: string | null = null) {
    super(`Command unavailable for partition ${partition}: ${reason}${movedTo ? ` (${movedTo})` : ''}`);
    this.name = 'CommandUnavailableError';
    this.reason = reason;
    this.partition = partition;
    this.movedTo = movedTo;
  }
}

/** Constant-time classification shared by Access, commands, HTTP, and durable work. */
export function classifyUnavailability(error: unknown): CommandUnavailableError['reason'] | undefined {
  if (error instanceof AccessUnavailableError || error instanceof CommandUnavailableError) return error.reason;
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
