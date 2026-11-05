import type { PoolClient } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';

/** Trusted producer operands participate in the native digest. Preparation defers business errors
 * until fresh execution, so original receipts remain usable after a lost acknowledgement. */
export type LabelCommandAdmission = {
  input: unknown;
  prepare(at: AuthoritativeTime): Promise<(tx: Pick<PoolClient, 'query'>) => Promise<void>>;
};
