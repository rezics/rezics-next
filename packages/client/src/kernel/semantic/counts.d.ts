import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
export type SubjectRelationCounts = {
    properties: Record<string, {
        out?: number;
        in?: number;
    }>;
    groups: Record<string, {
        out: number;
        in: number;
    }>;
    content: null;
};
type ProvenPropertyDirections = {
    out: number;
    in?: number;
} | {
    out?: number;
    in: number;
};
type ProvenGroupDirections = {
    out: number;
    in?: number;
} | {
    out?: number;
    in: number;
};
export type SubjectRelationCountResponse = {
    properties?: Record<string, ProvenPropertyDirections>;
    groups?: Record<string, ProvenGroupDirections>;
    content: null;
};
export declare function readSubjectRelationCounts(pool: Pool, options: {
    subject: string;
    release: Release;
    authorize: (client: PoolClient) => Promise<boolean>;
}): Promise<{
    counts: SubjectRelationCounts;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
}>;
export {};
