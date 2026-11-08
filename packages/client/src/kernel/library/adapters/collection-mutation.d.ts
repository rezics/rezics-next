/** Native metadata effects. Every leaf uses the caller's exact query client and retained declaration. */
import type { PoolClient } from 'pg';
import type { CollectionMutationPorts } from '../contract/index.ts';
type Client = Pick<PoolClient, 'query'>;
export declare function createNativeCollectionMutationPorts(): CollectionMutationPorts<Client>;
export {};
