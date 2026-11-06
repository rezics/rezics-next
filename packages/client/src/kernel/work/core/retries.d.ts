import type { WorkUnavailabilityReason } from '../contract/vocabulary.ts';
/** Classify durable-step unavailability from error shape, without Access or Command types. */
export declare function classifyWorkUnavailability(error: unknown): WorkUnavailabilityReason | undefined;
export declare function workStepShouldRetry(error: unknown): boolean;
/** Shared retry policy for durable steps that issue kernel commands. */
export declare const COMMAND_STEP_RETRIES: Readonly<{
    retriesAllowed: true;
    intervalSeconds: 1;
    backoffRate: 2;
    maxAttempts: 8;
    shouldRetry: typeof workStepShouldRetry;
}>;
