import type { CommandTransaction } from '../../command/command.ts';
import type { NativeIdentityCapabilities } from '../identity-adapter-port.ts';
import type { IdentityEpochStore } from './identity-epoch-contract.ts';
/** Same-transaction birth mapping; no identity job or participant is loaded or inferred. */
export declare function createIdentitySubjectInitializer(capabilities: NativeIdentityCapabilities): IdentityEpochStore['initializeSubject'];
export declare function initializeIdentitySubject(tx: CommandTransaction, original: string): Promise<void>;
