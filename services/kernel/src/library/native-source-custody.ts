import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { WorkAllowance, WorkReceipt } from './collection-source.ts';

/** Lookup hints only. Native records, not possession of this value, establish custody. */
export type NativeSourceIdentity = Readonly<{
  route: number;
  collectionId: string;
  accountId: string;
  incarnation: string;
  generation: string;
  scope: 'curated' | 'private_builtin';
  ownerEpoch: number;
  receivingEpoch: string;
  effectKey: string;
}>;
export type NativeSourceDriver =
  | 'member' | 'entry' | 'entry_deleted' | 'label' | 'assignment'
  | 'session' | 'unit' | 'change' | 'copy' | 'output' | 'done';
export type NativeSourceFrontier = Readonly<{
  captureId: string;
  driver: NativeSourceDriver;
  after: string;
  tie: string;
  sessionId: string | null;
  scanned: string;
  version: number;
}>;
declare const captureEvidence: unique symbol;
export type NativeSourceCapture = Readonly<{
  [captureEvidence]: true;
  identity: NativeSourceIdentity;
  captureId: string;
  transactionId: string;
  position: string;
  scanned: string;
}>;
declare const custodyEvidence: unique symbol;
export type NativeSourceCustody = Readonly<{
  [custodyEvidence]: true;
  identity: NativeSourceIdentity;
  captureId: string;
  holdId: string;
  transactionId: string;
}>;
export type NativeSourceCaptureWork = Readonly<{ allowance: WorkAllowance; deadline: number }>;
export type NativeSourceDependency = Readonly<{
  driver: NativeSourceDriver;
  key: string;
  tie: string;
  subjectId: string | null;
  transactionId: string | null;
}>;
type Unavailable = { status: 'unavailable'; reason: 'binding' | 'writer' | 'allowance' | 'output_authority'; work: WorkReceipt };
export interface NativeLibrarySourceCustody {
  capturePage(input: NativeSourceCaptureWork & {
    identity: NativeSourceIdentity;
    frontier: NativeSourceFrontier | null;
    limit: number;
  }): Promise<Unavailable | { status: 'pending'; frontier: NativeSourceFrontier; rows: readonly NativeSourceDependency[]; work: WorkReceipt }>;
  finishCapture(input: NativeSourceCaptureWork & {
    identity: NativeSourceIdentity;
    frontier: NativeSourceFrontier;
  }): Promise<Unavailable | { status: 'complete'; capture: NativeSourceCapture; work: WorkReceipt }>;
  /** Same native partition command client and T as adoption; never a foreign checkout/callback. */
  readAndHold(input: NativeSourceCaptureWork & {
    client: PoolClient;
    at: AuthoritativeTime;
    identity: NativeSourceIdentity;
    captureId: string;
    holdId: string;
  }): Promise<Unavailable | { status: 'held'; custody: NativeSourceCustody; work: WorkReceipt }>;
  releaseHold(input: NativeSourceCaptureWork & {
    client: PoolClient;
    at: AuthoritativeTime;
    identity: NativeSourceIdentity;
    captureId: string;
    holdId: string;
  }): Promise<Unavailable | { status: 'released'; work: WorkReceipt }>;
}

/** Declarations publish the closed seam; unimplemented adapters cannot claim readiness. */
export function createNativeLibrarySourceCustody(_dependencies: { pool: Pool; clock?: KernelClock }): NativeLibrarySourceCustody {
  const unavailable = async (input: NativeSourceCaptureWork): Promise<Unavailable> => ({
    status: 'unavailable', reason: 'binding', work: { reservationId: input.allowance.reservationId,
      used: { candidateKeys: 0, identityMetadataRows: 0, nativeRows: 0, nativePoints: 0, witnessKeys: 0, statements: 0, bytes: 0, emptySeeks: 0 } },
  });
  return { capturePage: unavailable, finishCapture: unavailable, readAndHold: unavailable, releaseHold: unavailable };
}
