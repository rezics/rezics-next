import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import type { Relay } from '../events/relays.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SessionComponent } from '../tokens/session.ts';
export declare const LINKS_CONSUMER = "semantic_links";
export declare function linkProjection(pool: Pool): Relay;
export type SubjectLink = {
    subject: string;
    property: string;
    statement: string;
    type?: string;
    label?: string;
};
export type SubjectLinksPage = {
    links: SubjectLink[];
    count?: {
        value: number;
        exact: boolean;
    };
    freshness: {
        consistency: 'eventual';
        target_seconds: 10;
        caught_up: boolean;
    };
    next: string | null;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
};
export declare function waitForSubjectLinks(pool: Pool, seen: readonly SessionComponent[], subject: string, deadline: number): Promise<boolean>;
export declare function listSubjectLinks(pool: Pool, ring: KeyRing, options: {
    subject: string;
    property: string | null;
    limit: number;
    filter?: string;
    type?: string;
    language?: string;
    includeLabels?: boolean;
    release?: Release;
    cursor?: string;
    authorize: (client: PoolClient) => Promise<boolean>;
    seen: readonly SessionComponent[];
    caughtUp?: boolean;
}): Promise<SubjectLinksPage>;
