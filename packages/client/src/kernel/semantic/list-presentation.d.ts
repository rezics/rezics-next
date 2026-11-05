import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import { type Fact } from '../search/hits.ts';
import type { WorkContext } from '../search/work-context.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    actor: Actor;
    routeKey: Uint8Array;
    deadline: number;
};
/** One current original-keyed public batch. No Source snapshot, index document or permission verdict is authority. */
export declare function readListPresentationFacts(deps: Dependencies, originals: readonly string[], options?: {
    languages?: readonly string[];
    workContext?: boolean;
}): Promise<Map<string, {
    id: string;
    facts: Record<string, Fact[]>;
    workContext?: WorkContext;
} | null>>;
export {};
