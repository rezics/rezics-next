import type { Pool } from 'pg';
type AccountContextDependencies = Readonly<{
    pool: Pool;
    deadline: number;
}>;
type Account = {
    id: string;
    revision: string;
    handle: string | null;
    agent: string | null;
    agentReceipt: string | null;
};
/** Derived IDs are lookup keys only. A stored exact reciprocal link AND installed native
 * identity publication must prove the subject; a formula or an Account UUID never does.
 * The caller compares two observations around anonymous subject hydration.
 */
export declare function readAccountContextBindings(deps: AccountContextDependencies, accounts: readonly Account[]): Promise<Map<string, {
    id: string;
    source: string;
}>>;
export {};
