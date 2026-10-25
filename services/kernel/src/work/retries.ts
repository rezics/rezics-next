import type { StepConfig } from '@dbos-inc/dbos-sdk';
import { CommandUnavailableError } from '../command/command.ts';

/** Shared DBOS retry policy for durable steps that issue kernel commands. */
export const COMMAND_STEP_RETRIES = Object.freeze({
  retriesAllowed: true,
  intervalSeconds: 1,
  backoffRate: 2,
  maxAttempts: 8,
  shouldRetry: (error: unknown) =>
    error instanceof CommandUnavailableError &&
    (error.reason === 'overloaded' ||
      error.reason === 'contention' ||
      error.reason === 'deadline' ||
      error.reason === 'fenced'),
} satisfies StepConfig & { shouldRetry: (error: unknown) => boolean });
