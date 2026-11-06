import { memoizedValue } from '../../memoized.ts';
import type { SubjectFactStorePort } from '../contract/domain-ports.ts';
import { identityEpochStore } from '../identity-adapters/index.ts';
import { writeFacts } from '../write-facts.ts';

type NativeFactTransaction = Parameters<ReturnType<typeof identityEpochStore>['initializeSubject']>[0];

/** Native fact log and identity birth mapping. SQL stays in this adapter. */
export function nativeFactStore(): SubjectFactStorePort<NativeFactTransaction> {
  return memoizedValue(nativeFactStore, () =>
    Object.freeze({
      writeFacts: (tx, input) => writeFacts(tx, input),
      initializeIdentity: (tx, original) => identityEpochStore().initializeSubject(tx, original),
    }),
  );
}
