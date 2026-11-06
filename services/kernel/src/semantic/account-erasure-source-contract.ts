export type SubjectErasureSourceBarrier = HistoryBarrier;
import type {
  PublicFilterCost,
  PublicFilterProjectionObservation,
  PublicFilterReadContext,
  PublicFilterRepairLocator,
  PublicFilterSourceFactory,
} from './public-filter-source-contract.ts';
import { type HistoryBarrier } from '../history/contract/index.ts';

declare const subjectErasurePageReceipt: unique symbol;
declare const subjectErasureSourceProof: unique symbol;
/** Durable all-home Source terminal proof; independent of discovery and participant ACKs. */
export type SubjectErasureSourceProof = Readonly<{
  id: string;
  [subjectErasureSourceProof]: true;
}>;
/** A durable native page locator. The private brand is not evidence of custody. */
export type SubjectErasurePageReceipt = Readonly<{
  id: string;
  [subjectErasurePageReceipt]: true;
}>;

export type SubjectErasureSourceRecord = Readonly<{
  /** Opaque native directory identity, including authentic transaction/position origin.
   * Equal physical roles and delivery positions can produce distinct records.
   */
  key: string;
  original: string;
  previousTerminal: string | null;
  currentTerminal: string | null;
  disposition: 'remove' | 'replace' | 'retain_deidentified' | 'pending';
  source: PublicFilterProjectionObservation | null;
  repairLocators: readonly PublicFilterRepairLocator[];
}>;
export type SubjectErasureSourceRequest = Readonly<{
  barrier: HistoryBarrier;
  frontier: string | null;
  inputLimit: number;
  context: PublicFilterReadContext;
}>;
/** Financial receiving's overflow operands: the refused bound, the quoted count and the caller's funding. */
export type SubjectErasureSourceOverflow = Readonly<{
  error: 'keys' | 'bytes' | 'deadline';
  count: number;
  funding: number;
}>;
export type SubjectErasureSourcePage =
  | Readonly<{
      status: 'progress';
      records: readonly SubjectErasureSourceRecord[];
      frontier: string;
      receipt: SubjectErasurePageReceipt;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'complete';
      records: readonly SubjectErasureSourceRecord[];
      frontier: null;
      receipt: SubjectErasurePageReceipt;
      cost: PublicFilterCost;
    }>
  | Readonly<{
      status: 'pending';
      cost: PublicFilterCost;
      count: number;
      error: SubjectErasureSourceOverflow['error'] | null;
      funding: number;
    }>
  | Readonly<{ status: 'unavailable'; cost: PublicFilterCost }>;
export type SubjectErasureSource = Readonly<{
  readPage(input: SubjectErasureSourceRequest): Promise<SubjectErasureSourcePage>;
}>;
export type SubjectErasureSourceFactory = (config: Parameters<PublicFilterSourceFactory>[0]) => SubjectErasureSource;
