import { Value } from 'typebox/value';
import type { TSchema } from 'typebox';
import type { Pool } from 'pg';
import { ensureAccountAgent } from '../semantic/account-agents.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { ACCESS_EVENTS } from './events.ts';
import { reverseDeletedAccountAgent } from './agent-verification.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readAccount, type Account } from './account-data.ts';

export const ACCOUNT_AGENT_EVENT_TYPES = [
  'com.rezics.access.account-tombstoned.v1',
  'com.rezics.access.actor-activated.v1',
  'com.rezics.access.organization-created.v1',
  'com.rezics.access.account-display-name-changed.v1',
] as const;

export type AccountAgentSource = Pick<
  Account,
  'accountId' | 'kind' | 'state' | 'handle' | 'displayName' | 'operatorAccountId' | 'fenced'
>;

/** Resolve the semantic identity from current Access state shared by the effect and backfill. */
export function accountAgentOptions(account: AccountAgentSource) {
  if (account.state !== 'active' || account.fenced) return null;
  const kind: 'organization' | 'person' | 'software' | null =
    account.kind === 'organization'
      ? 'organization'
      : account.kind === 'actor'
        ? account.operatorAccountId === null
          ? 'person'
          : 'software'
        : null;
  if (kind === null) throw new TypeError('Active account has an unsupported kind');
  const name = account.displayName || account.handle;
  if (typeof name !== 'string' || name.length === 0)
    throw new Error(`Active account ${account.accountId} has neither a display name nor a handle`);
  return { account: account.accountId, kind, name, language: 'und' as const };
}

function validateEvent(event: CloudEvent): string {
  const schema = (ACCESS_EVENTS as unknown as Record<string, TSchema>)[event.type];
  if (
    !ACCOUNT_AGENT_EVENT_TYPES.includes(event.type as (typeof ACCOUNT_AGENT_EVENT_TYPES)[number]) ||
    !schema ||
    !Value.Check(schema, event.data)
  )
    throw new TypeError('Invalid account agent event');
  const accountId = (event.data as { accountId: string }).accountId;
  const route = routeOf(accountId);
  const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  const epoch = Number(source?.[2]);
  if (
    route === null ||
    !source ||
    Number(source[1]) !== partitionOf(route) ||
    !Number.isSafeInteger(epoch) ||
    epoch > 2147483647 ||
    !/^\d{19}$/.test(event.sequence) ||
    BigInt(event.sequence) <= 0n ||
    BigInt(event.sequence) > 9223372036854775807n ||
    event.subject !== accountId
  )
    throw new TypeError('Invalid account agent event envelope');
  return accountId;
}

/** Register through the accounts WorkModule; delivery retries after an account commit. */
export function createAccountAgentEffect(pool: Pool): Effect {
  return {
    name: 'account_agent',
    types: [...ACCOUNT_AGENT_EVENT_TYPES],
    run: (event) => applyAccountAgentEffect(pool, event),
  };
}

/** Events carry only an account reference; each delivery converges from its anchored current row. */
export async function applyAccountAgentEffect(pool: Pool, event: CloudEvent): Promise<void> {
  const accountId = validateEvent(event);
  const route = routeOf(accountId)!;
  const account = await withConnection(pool, (client) => readAccount(client, route, accountId));
  if (!account) return;
  if (account.state === 'deleted') {
    await reverseDeletedAccountAgent(pool, accountId);
    return;
  }
  const options = accountAgentOptions(account);
  if (!options) return;
  await ensureAccountAgent(pool, options);
}
