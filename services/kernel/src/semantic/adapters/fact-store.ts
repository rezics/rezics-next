import { memoizedValue } from '../../memoized.ts';
import type { SubjectFactStorePort } from '../contract/domain-ports.ts';
import { initializeIdentitySubject } from '../identity-adapters/subject-creation.ts';
import { writeFacts } from '../write-facts.ts';

type NativeFactTransaction = Parameters<typeof initializeIdentitySubject>[0];

/** Native fact log and identity birth mapping. SQL stays in this adapter. */
export function nativeFactStore(): SubjectFactStorePort<NativeFactTransaction> {
  return memoizedValue(nativeFactStore, () =>
    Object.freeze({
      writeFacts: (tx, input) => writeFacts(tx, input),
      initializeIdentity: (tx, original) => initializeIdentitySubject(tx, original),
    }),
  );
}
