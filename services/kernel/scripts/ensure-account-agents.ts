import type { Pool } from 'pg';
import { withConnection, createPool } from '../src/database/pool.ts';
import pageActiveAccounts from '../src/access/account-agent-active-page.sql';
import { accountAgentOptions } from '../src/access/account-agent-effect.ts';
import { ensureAccountAgent } from '../src/semantic/account-agents.ts';

export const ACCOUNT_AGENT_PAGE_SIZE = 100;

type AccountRow = Parameters<typeof accountAgentOptions>[0] & { route: number };

function rowsOf<T>(value: T[] | T | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Idempotent deployment backfill. Each scan page is released before per-account commands run. */
export async function ensureActiveAccountAgents(pool: Pool): Promise<number> {
  let afterRoute = -1;
  let afterAccountId = '00000000-0000-0000-0000-000000000000';
  let ensured = 0;
  while (true) {
    const page = await withConnection(pool, async (client) =>
      rowsOf(
        (await pageActiveAccounts.run(client, {
          after_route: afterRoute,
          after_account_id: afterAccountId,
          page_size: ACCOUNT_AGENT_PAGE_SIZE,
        })) as AccountRow[] | AccountRow | null,
      ),
    );
    if (page.length === 0) return ensured;
    for (const account of page) {
      const options = accountAgentOptions(account);
      if (options) {
        await ensureAccountAgent(pool, options);
        ensured += 1;
      }
    }
    const last = page.at(-1)!;
    afterRoute = last.route;
    afterAccountId = last.accountId;
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) throw new Error('DATABASE_URL is required');
  const pool = createPool(databaseUrl);
  try {
    const ensured = await ensureActiveAccountAgents(pool);
    console.info(`Ensured account agents for ${ensured} active accounts`);
  } finally {
    await pool.end();
  }
}
