import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { SubjectComponent } from './contract/subject-values.ts';
export type TermDetailWitness = {
    id: string;
    component: SubjectComponent;
    revision: number | null;
    securityRevision: string;
};
export declare function termDisclosureSql(): string;
/** Revalidate the original terms on one fresh statement snapshot. Incomplete account,
 * resource or home evidence returns to the ordinary prepared summary reader. */
export declare function termSummaryDisclosure({ pool, access, actor, deadline }: {
    pool: Pool;
    access: Access;
    actor: Actor;
    deadline: number;
}, witness: TermDetailWitness): Promise<boolean | 'changed' | undefined>;
