import type { StepConfig } from '@dbos-inc/dbos-sdk';
import { classifyUnavailability } from '../request/unavailable.ts';

/** Shared DBOS retry policy for durable steps that issue kernel commands. */
export const COMMAND_STEP_RETRIES = Object.freeze({
  retriesAllowed: true,
  intervalSeconds: 1,
  backoffRate: 2,
  maxAttempts: 8,
  shouldRetry: (error: unknown) => {
    const reason = classifyUnavailability(error);
    return reason === 'deadline' || reason === 'contention' || reason === 'overloaded' || reason === 'fenced';
  },
} satisfies StepConfig & { shouldRetry: (error: unknown) => boolean });
