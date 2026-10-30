import type { CommandTransaction } from '../command/command.ts';
import type { RecordPurgeAuthority } from '../semantic/record-purge-authority.ts';

/** Provisional consumer boundary: Semantic must publish this opaque native producer type.
 * History never constructs a set, reads Semantic SQL or accepts a member vector. */
declare const semanticRecordSourceSet: unique symbol;
export type SemanticRecordSourceSet = Readonly<{ [semanticRecordSourceSet]: true }>;
export type RecordSourceSetIdentity = Readonly<{
  sourcePartition: number;
  locator: Uint8Array;
  revision: Uint8Array;
}>;
export type RecordSourceSetCommitment = RecordSourceSetIdentity & Readonly<{
  originalTransaction: string;
  memberCount: number;
}>;

/** Required native adapter surface, not an implementation or an issuer. The producer must
 * verify its immutable row, exact original transaction, complete membership and reverse index.
 * Binary locators/revisions are owner-issued; History assigns neither format nor native IDs. */
export type RecordSourceSetProducer = Readonly<{
  readCommandRecordSourceSet(
    tx: CommandTransaction,
    sourceSet: SemanticRecordSourceSet,
  ): Promise<RecordSourceSetCommitment | null>;
  verifyRecordSourceSet(tx: CommandTransaction, set: RecordSourceSetCommitment): Promise<boolean>;
  readRecordSourceSetMembership(
    tx: CommandTransaction,
    authority: RecordPurgeAuthority,
    frontier: Uint8Array | null,
    limit: number,
  ): Promise<Readonly<{
    sets: readonly RecordSourceSetCommitment[];
    frontier: Uint8Array | null;
    state: 'pending' | 'more' | 'sealed';
  }>>;
}>;

export class RecordSourceSetUnavailableError extends Error {
  readonly code = 'record_history_native_source_set_unavailable';
  constructor() {
    super('record_history_native_source_set_unavailable');
    this.name = 'RecordSourceSetUnavailableError';
  }
}

/** No native module is present in this base. Keep the exact missing producer module visible;
 * replacing this boundary requires its owner's real declarations, not a structural cast or
 * a process-local registration/WeakMap issuer. Independent History storage remains usable. */
export async function nativeRecordSourceSetProducer(): Promise<RecordSourceSetProducer> {
  throw new RecordSourceSetUnavailableError();
}
