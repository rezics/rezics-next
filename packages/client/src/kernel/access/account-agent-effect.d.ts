import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { type Account } from './account-data.ts';
export declare const ACCOUNT_AGENT_EVENT_TYPES: readonly ['com.rezics.access.account-tombstoned.v1', 'com.rezics.access.actor-activated.v1', 'com.rezics.access.organization-created.v1', 'com.rezics.access.account-display-name-changed.v1'];
export type AccountAgentSource = Pick<Account, 'accountId' | 'kind' | 'state' | 'handle' | 'displayName' | 'operatorAccountId' | 'fenced'>;
/** Resolve the semantic identity from current Access state shared by the effect and backfill. */
export declare function accountAgentOptions(account: AccountAgentSource): {
    account: string;
    kind: "organization" | "person" | "software";
    name: string;
    language: 'und';
} | null;
/** Register through the accounts WorkModule; delivery retries after an account commit. */
export declare function createAccountAgentEffect(pool: Pool): Effect;
/** Events carry only an account reference; each delivery converges from its anchored current row. */
export declare function applyAccountAgentEffect(pool: Pool, event: CloudEvent): Promise<void>;
