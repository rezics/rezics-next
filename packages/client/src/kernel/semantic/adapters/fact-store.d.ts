import type { SubjectFactStorePort } from '../contract/domain-ports.ts';
import { initializeIdentitySubject } from '../identity-adapters/subject-creation.ts';
type NativeFactTransaction = Parameters<typeof initializeIdentitySubject>[0];
/** Native fact log and identity birth mapping. SQL stays in this adapter. */
export declare function nativeFactStore(): SubjectFactStorePort<NativeFactTransaction>;
export {};
