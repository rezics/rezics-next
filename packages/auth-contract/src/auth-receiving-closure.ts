declare const currentAuthReceivingClosure: unique symbol;

/** Producer-issued current receiving closure. The brand is never serialized.
 * A historical AuthErasureBarrier or copies-erased publication cannot construct
 * this capability. Its durable locator and receiver binding belong to Auth.
 */
export type CurrentAuthReceivingClosure = Readonly<{ [currentAuthReceivingClosure]: true }>;

import type { AuthErasureBarrier, AuthErasureSource } from './index.ts';

/** Native Access control observation, never an owner installation request. All
 * identity fields require original ownership records outside the Auth image.
 * controlRevision is a fencing sequence; it is NOT a receiving incarnation.
 */
export type AuthReceivingBinding = Readonly<{
  partition: number;
  sourceGeneration: string;
  sourceEpoch: number;
  sourceOwner: string;
  controlRevision: string;
  databaseIdentity: string;
  receivingIncarnation: string;
  restoreGeneration: string;
  ownerInstallation: string;
  writerFence: string;
}>;

export type AuthReceivingRegistration =
  | Readonly<{ state: 'bound'; binding: AuthReceivingBinding }>
  | Readonly<{ state: 'pending'; reason: 'source-unavailable' | 'physical-owner-unavailable' }>;

/** Exact private producer wire. Source fields are reread from the accepted
 * native obligation; receiver fields come only from independent Access control.
 */
export type AuthReceivingClosurePublication = Readonly<{
  format: 'auth.receiving-closure/v1';
  source: Readonly<AuthErasureSource>;
  binding: AuthReceivingBinding;
  nativeObligationId: string;
  closureReceiptId: string;
}>;

/** Private native proof-factory read. Returns a locator only after rereading
 * Auth's actual committed native closure, never a caller's publication blob.
 */
export type AuthReceivingClosureProducer = {
  readClosure(input: {
    barrier: AuthErasureBarrier;
    nativeObligationId: string;
    binding: AuthReceivingBinding;
    deadline: number;
  }): Promise<AuthReceivingClosurePublication | null>;
};

/** Fixed Auth/Access service operations. Registration creates a pending native
 * obligation; it cannot invent or install an original physical owner.
 */
export type AuthReceivingClosurePorts = {
  readAuthReceivingControl(input: {
    partition: number;
    restoreGeneration: string;
    deadline: number;
  }): Promise<AuthReceivingBinding | null>;
  registerAuthReceivingClosure(input: {
    barrier: AuthErasureBarrier;
    deadline: number;
  }): Promise<AuthReceivingRegistration>;
  invalidateAuthReceivingClosure(input: {
    partition: number;
    restoreGeneration: string;
    deadline: number;
  }): Promise<boolean>;
  publishAuthReceivingClosure(input: {
    barrier: AuthErasureBarrier;
    nativeObligationId: string;
    deadline: number;
  }): Promise<boolean>;
};
