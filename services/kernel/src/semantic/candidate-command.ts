import type { CommandTransaction } from '../command/command.ts';
import { baseOf } from './definition-release-read.ts';
import insertEditorialRevision from './candidates-insert-editorial-revision.sql';
import updateSubjectRelease from './update-subject-release.sql';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Unique collisions that are concurrent command races, not durable editorial conflicts. */
export const PROPOSAL_UNIQUE_CONTENTION_CONSTRAINTS = ['revision_pkey', 'candidate_pkey', 'fact_pkey'] as const;
export const BULK_UNIQUE_CONTENTION_CONSTRAINTS = [
  'external_claim_pkey',
  'source_candidate_pkey',
  'receipt_pkey',
  'revision_pkey',
  'candidate_pkey',
] as const;

/** Core retries 40001 until the original deadline; this is not an HTTP outer-retry count. */
export function asUniqueContention(error: unknown, constraints: readonly string[]): unknown {
  if (record(error) && error.code === '23505' && constraints.includes(String(error.constraint))) error.code = '40001';
  return error;
}

export async function appendEditorialRevision(
  tx: CommandTransaction,
  input: {
    subject: string;
    route: number;
    revision: number;
    release: string;
    kind: 'accept' | 'reject' | 'adopt';
    transactionId: string;
  },
): Promise<void> {
  await insertEditorialRevision.run(tx, {
    route: input.route,
    subject_id: input.subject,
    revision: input.revision,
    kind: input.kind,
    release: baseOf(input.release),
    transaction_id: input.transactionId,
  });
  await updateSubjectRelease.run(tx, {
    route: input.route,
    subject_id: input.subject,
    release: baseOf(input.release),
  });
}

export function retryEditorialUniqueness(error: unknown): void {
  asUniqueContention(error, ['revision_pkey', 'acceptance_pkey', 'adoption_pkey']);
}
