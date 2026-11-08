import type { CommandTransaction } from '../../command/command.ts';
import type { NativeIdentityCapabilities } from '../identity-adapter-port.ts';
/** One callback and one purpose per native transaction, shared by all capability-bound callers. */
export declare function createIdentityNativeCommitRecorder(capabilities: NativeIdentityCapabilities): (tx: CommandTransaction, purpose: string) => void;
export declare function recordIdentityEpochNativeCommit(tx: CommandTransaction, purpose: string): void;
