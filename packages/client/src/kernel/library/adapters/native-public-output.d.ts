import type { Pool, PoolClient } from 'pg';
import type { AuthoritativeTime, CommandTransaction } from '../../command/command.ts';
import type { NativeCollectionWork } from '../collection-native-work.ts';
import type { LockPublicOutputDisposition, NativePublicOutputApplication, ObserveNativePublicOutput } from '../contract/native-public-output.ts';
type Client = Pick<PoolClient, 'query'>;
export type NativePublicOutputAdapterPorts = Readonly<{
    observe: ObserveNativePublicOutput<Client, NativeCollectionWork>;
    lockDisposition: LockPublicOutputDisposition<CommandTransaction, Pool, AuthoritativeTime>;
}>;
/** Assemble SQL custody with the current Library observation and Semantic receiving capabilities. */
export declare function createNativePublicOutputAdapter(ports: NativePublicOutputAdapterPorts): NativePublicOutputApplication<CommandTransaction, Pool, AuthoritativeTime>;
export {};
