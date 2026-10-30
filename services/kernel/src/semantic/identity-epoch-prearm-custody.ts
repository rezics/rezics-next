import type { Pool } from 'pg';
import type { IdentityFrontier, IdentityJobRef, NativeStepWork } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketData } from './identity-epoch-prearm-contract.ts';

export type IdentityPrearmCustodyRequest = Readonly<{
  job: IdentityJobRef;
  after: IdentityFrontier | null;
  limit: number;
  allowance: NativeStepWork;
}>;
export type IdentityPrearmCustodyContext = Readonly<{ deadline: number }>;
declare const custodyCut: unique symbol;
/** Only the exact retained admitted native input directory; no consumer completion authority. */
export type IdentityPrearmCustodyCut = Readonly<{ [custodyCut]: true }>;
export type IdentityPrearmCustodyPage =
  | Readonly<{ status: 'progress'; tickets: readonly IdentityPrearmTicketData[]; frontier: IdentityFrontier; work: NativeStepWork }>
  | Readonly<{ status: 'complete'; tickets: readonly IdentityPrearmTicketData[]; frontier: IdentityFrontier; cut: IdentityPrearmCustodyCut; work: NativeStepWork }>
  | Readonly<{ status: 'unavailable'; reason: string; work: NativeStepWork }>;
export type IdentityPrearmCustodyVerification = Readonly<{
  status: 'current' | 'unavailable';
  work: NativeStepWork;
}>;

export async function readIdentityPrearmCustodyPage(
  _pool: Pool, _request: IdentityPrearmCustodyRequest, _context: IdentityPrearmCustodyContext,
): Promise<IdentityPrearmCustodyPage> {
  // Declaration publication only; the same worker supplies native reads in the next commit.
  return { status: 'unavailable', reason: 'native-implementation-pending', work: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 } };
}
export async function verifyIdentityPrearmCustodyCut(
  _pool: Pool, _job: IdentityJobRef, _cut: IdentityPrearmCustodyCut, _context: IdentityPrearmCustodyContext,
): Promise<IdentityPrearmCustodyVerification> {
  return { status: 'unavailable', work: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 } };
}
