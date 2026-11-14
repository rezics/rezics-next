import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../session/reading-policy';
import type { YearlyGoalReadResult } from './yearly-goal-page';

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
