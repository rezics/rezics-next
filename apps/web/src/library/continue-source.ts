import type { KernelClient } from '@rezics/client';
import type { SubjectSummary } from '../media/summary';
import type { ProgressLabelInput } from './progress-label';

export const CONTINUE_LIMIT = 6;
export type ContinueProgress = ProgressLabelInput & { sessionId: string };
export type ContinueEntry = {
  subjectId: string;
  label: string;
  language?: string;
  summary: SubjectSummary;
  progress: ContinueProgress | null;
  stateLabel?: string;
};

/** Consumer presentation, not a replacement native DTO or a second Library index. */
export type ContinueFailure =
  | { state: 'unavailable'; status?: number; reason?: 'missing-binding' | 'invalid-address' | 'stale-address' }
  | { state: 'preparing'; retryAfter?: number }
  | { state: 'denied'; status: 401 | 403 }
  | { state: 'signed-out' };
export type ContinueResult = { state: 'loaded'; entries: ContinueEntry[]; next: string | null } | ContinueFailure;
export type ContinueView = ContinueResult | { state: 'unknown' };

/** One native FULL page carries both private progress and currently authorized subject presentation. */
export type ContinueSource = (
  client: KernelClient,
  authorization: string,
  input: { limit: number; cursor?: string },
  signal?: AbortSignal,
) => Promise<ContinueResult>;

export function continueProgress(session: (ProgressLabelInput & { id: string }) | null): ContinueProgress | null {
  return session
    ? {
        sessionId: session.id,
        mode: session.mode,
        unit: session.unit,
        ...(session.unitLabel === undefined ? {} : { unitLabel: session.unitLabel }),
        ...(session.unitLabelLanguage === undefined ? {} : { unitLabelLanguage: session.unitLabelLanguage }),
        ...(session.unitCountForms === undefined ? {} : { unitCountForms: session.unitCountForms }),
        ...(session.dimension === undefined ? {} : { dimension: session.dimension }),
        amount: session.amount,
        total: session.total,
        completedUnitCount: session.completedUnitCount,
        locator: session.locator,
        ...(session.position === undefined ? {} : { position: session.position }),
      }
    : null;
}

export class ContinueReadError extends Error {
  readonly state: ContinueFailure['state'];
  constructor(readonly failure: ContinueFailure) {
    super(`Continue ${failure.state}`);
    this.name = 'ContinueReadError';
    this.state = failure.state;
  }
}

/** No automatic polling of an unavailable producer; preparation may get two bounded retries. */
export function continueRetryDelay(result: ContinueView, attempts: number): number | null {
  if (result.state !== 'preparing' || attempts >= 2) return null;
  return Math.min(30, Math.max(1, result.retryAfter ?? 2)) * 1000;
}

/** Map the native response status without turning an error or readiness response into empty success. */
export function continueFailure(status: number, retryAfter?: string | null, problem?: unknown): ContinueFailure {
  if (status === 202) {
    const seconds = retryAfter ? Number(retryAfter) : NaN;
    return { state: 'preparing', ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfter: seconds } : {}) };
  }
  if (status === 401 || status === 403) return { state: 'denied', status };
  const code = typeof problem === 'object' && problem !== null && 'code' in problem ? problem.code : undefined;
  if ((status === 400 && code === 'invalid_cursor') || (status === 409 && code === 'stale_cursor'))
    return { state: 'unavailable', status, reason: 'stale-address' };
  return { state: 'unavailable', status };
}
