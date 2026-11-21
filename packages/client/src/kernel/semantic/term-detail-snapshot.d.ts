import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import { type SubjectComponent } from './contract/subject-values.ts';
import type { SubjectReadRow } from './subject-reading-application.ts';
export declare function termDetailSql(): string;
/** One fresh native statement can prove a small Global term detail. A missed shape
 * or incomplete witness leaves all disclosure, redirect and wait decisions to the full reader. */
export declare function readTermDetailSnapshot(runtime: {
    pool: Pool;
    access: Access;
    actor: Actor;
    deadline: number;
}, id: string, seen: readonly SubjectComponent[]): Promise<{
    rows: (SubjectReadRow & {
        epoch: number;
        position: string;
        digest: string;
        supported: boolean;
    })[];
    release: import("@rezics/definitions").Release;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
} | undefined>;
