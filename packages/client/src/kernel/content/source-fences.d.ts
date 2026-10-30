import type { PoolClient } from 'pg';
import type { ImportedFieldGroup } from './imported-contract.ts';
export type SourceFenceTuple = Readonly<{
    route: number;
    source: string;
    external_id: string;
    field_group: ImportedFieldGroup;
}>;
export type SourceFence = SourceFenceTuple & Readonly<{
    takenDown: boolean;
    securityRevision: string | null;
    takenDownAt?: string;
    takedownId?: string;
}>;
/**
 * Internal fact read, never a permission check. The caller computes routes with
 * tupleRoute using its stable route key and owns the independently anchored
 * client. Each statement reads one partition. No pool checkout, anchor or Access query occurs here.
 */
export declare function readFences(client: Pick<PoolClient, 'query'>, tuples: readonly SourceFenceTuple[]): Promise<readonly SourceFence[]>;
