import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../session/reading-policy';
import type { YearlyGoalCommand, YearlyGoalReadResult, YearlyGoalWriteResult } from './yearly-goal-page';

export type NativeYearlyGoal = NonNullable<
  Awaited<ReturnType<KernelClient['libraryYearlyCompletionGoal']['get']>>['data']
>;

export const YEARLY_GOAL_METRIC = 'completed_consumption_occurrences' as const;

/** One bounded native composition; no diary scan or independently cached summary. */
export async function readYearlyGoal(
  client: KernelClient,
  authorization: string,
  year: number,
  signal: AbortSignal,
): Promise<YearlyGoalReadResult> {
  let result;
  try {
    result = await client.libraryYearlyCompletionGoal.get({
      query: { year },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual', signal },
    });
  } catch (error) {
    return { state: signal.aborted ? 'retired' : isPlatformClosedError(error) ? 'denied' : 'unavailable' };
  }
  if (signal.aborted) return { state: 'retired' };
  if (
    !result.error &&
    result.data?.year === year &&
    result.data.metric === YEARLY_GOAL_METRIC &&
    result.data.viewer.state === 'owner' &&
    (result.data.progress.state !== 'available' || result.data.progress.summary.year === year)
  )
    return { state: 'ready', value: result.data };
  return { state: result.status === 401 ? 'retired' : result.status === 403 ? 'denied' : 'unavailable' };
}

/** Receipt acknowledgement is about this command, independently of the next year's summary read. */
export async function writeYearlyGoal(
  client: KernelClient,
  authorization: string,
  command: YearlyGoalCommand,
  signal: AbortSignal,
): Promise<YearlyGoalWriteResult> {
  const { idempotencyKey, ...body } = command;
  let result;
  try {
    result = await client.libraryYearlyCompletionGoal.put(body, {
      headers: { authorization, 'idempotency-key': JSON.stringify(idempotencyKey) },
      fetch: { cache: 'no-store', redirect: 'manual', signal },
    });
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'denied' : 'uncertain' };
  }
  if (
    !result.error &&
    result.data?.year === command.year &&
    result.data.metric === command.metric &&
    result.data.target === command.target &&
    /^[1-9][0-9]{0,18}$/.test(result.data.revision)
  )
    return { state: 'applied' };
  if (result.status === 401) return { state: 'retired' };
  if (result.status === 403) return { state: 'denied' };
  if (result.status === 409) return { state: 'stale' };
  const problem = result.error?.value;
  const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
  if (result.status === 422) return { state: code === 'idempotency_conflict' ? 'key-conflict' : 'invalid' };
  if (result.status === 400) return { state: 'invalid' };
  if (result.status === 410 && code === 'command_result_erased') return { state: 'erased' };
  if (problem && typeof problem === 'object' && 'effect_status' in problem && problem.effect_status === 'not_applied')
    return { state: 'unavailable' };
  // A malformed success, redirect or server failure without non-application evidence cannot resolve an intent.
  return { state: 'uncertain' };
}
